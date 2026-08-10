import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { newId } from "../src/shared/ids";
import {
    countRows,
    createTestApp,
    eventsByAction,
    resetDb,
    TestApp,
} from "./app-helpers";

/**
 * Integración del dominio Process sobre la app real (supertest + :memory:).
 */
describe("Process API", () => {
    let app: TestApp;

    beforeAll(async () => {
        app = await createTestApp();
    });

    afterAll(async () => {
        await app.close();
    });

    beforeEach(() => {
        resetDb(app.db);
    });

    /** Crea un proceso vía API y devuelve el body. */
    async function createProcess(roleTitle = "Backend Developer") {
        const res = await app.request
            .post("/process")
            .send({ roleTitle, roleContext: "Equipo de plataforma" });
        expect(res.status).toBe(201);
        return res.body as { id: string; roleTitle: string };
    }

    describe("GET /process", () => {
        it("devuelve 404 NOT_FOUND si no hay proceso activo", async () => {
            const res = await app.request.get("/process");
            expect(res.status).toBe(404);
            expect(res.body.error.code).toBe("NOT_FOUND");
        });

        it("devuelve el proceso activo", async () => {
            const created = await createProcess("Data Engineer");
            const res = await app.request.get("/process");
            expect(res.status).toBe(200);
            expect(res.body).toMatchObject({
                id: created.id,
                roleTitle: "Data Engineer",
                roleContext: "Equipo de plataforma",
                status: "active",
                closedAt: null,
            });
            expect(typeof res.body.createdAt).toBe("string");
        });
    });

    describe("POST /process", () => {
        it("crea el proceso y registra el evento de auditoría", async () => {
            const created = await createProcess();
            const events = eventsByAction(app.db, "process.created");
            expect(events).toHaveLength(1);
            expect(events[0].entity_type).toBe("process");
            expect(events[0].entity_id).toBe(created.id);
        });

        it("rechaza roleTitle vacío o ausente con INVALID_INPUT", async () => {
            for (const body of [
                {},
                { roleTitle: "" },
                { roleTitle: "   " },
                { roleTitle: 7 },
            ]) {
                const res = await app.request.post("/process").send(body);
                expect(res.status).toBe(400);
                expect(res.body.error.code).toBe("INVALID_INPUT");
            }
            expect(countRows(app.db, "process")).toBe(0);
        });

        it("abre otro proceso sin cerrar el anterior y lo deja seleccionado", async () => {
            const primero = await createProcess("Rol A");
            const segundo = await createProcess("Rol B");

            // Los dos siguen vivos y abiertos: crear ya no cierra nada.
            expect(countRows(app.db, "process")).toBe(2);
            const list = await app.request.get("/process/list");
            expect(list.status).toBe(200);
            expect(
                (list.body as { status: string }[]).every(
                    (p) => p.status === "active",
                ),
            ).toBe(true);

            // El nuevo pasa a ser el seleccionado; el anterior deja de serlo.
            const current = await app.request.get("/process");
            expect(current.body.id).toBe(segundo.id);
            expect(current.body.isCurrent).toBe(true);
            expect(
                (list.body as { id: string; isCurrent: boolean }[]).find(
                    (p) => p.id === primero.id,
                )?.isCurrent,
            ).toBe(false);
        });

        it("audita de qué proceso venía al crear el nuevo", async () => {
            const primero = await createProcess("Rol A");
            await createProcess("Rol B");
            const events = eventsByAction(app.db, "process.created");
            expect(events).toHaveLength(2);
            expect(JSON.parse(events[1].metadata as string)).toEqual({
                previousProcessId: primero.id,
                totalProcesses: 2,
            });
        });

        it("la DB impide dos procesos SELECCIONADOS a la vez", () => {
            app.db
                .prepare(
                    "INSERT INTO process (id, role_title, is_current) VALUES (?, ?, 1)",
                )
                .run(newId(), "Rol A");
            expect(() =>
                app.db
                    .prepare(
                        "INSERT INTO process (id, role_title, is_current) VALUES (?, ?, 1)",
                    )
                    .run(newId(), "Rol B"),
            ).toThrow(/UNIQUE/);
        });
    });

    describe("GET /process/list", () => {
        it("devuelve lista vacía si no hay procesos", async () => {
            const res = await app.request.get("/process/list");
            expect(res.status).toBe(200);
            expect(res.body).toEqual([]);
        });

        it("lista cada proceso con su recuento de candidatos vivos", async () => {
            await createProcess("Rol A");
            await app.request.post("/candidates").send({ name: "Uno" });
            await app.request.post("/candidates").send({ name: "Dos" });
            const segundo = await createProcess("Rol B");

            const res = await app.request.get("/process/list");
            expect(res.status).toBe(200);
            const byTitle = Object.fromEntries(
                (res.body as { roleTitle: string; candidateCount: number }[]).map(
                    (p) => [p.roleTitle, p.candidateCount],
                ),
            );
            expect(byTitle).toEqual({ "Rol A": 2, "Rol B": 0 });
            // El más reciente primero (es el que se suele querer retomar).
            expect(res.body[0].id).toBe(segundo.id);
        });

        it("no expone el contexto del rol en la lista", async () => {
            await createProcess();
            const res = await app.request.get("/process/list");
            expect(res.body[0].roleContext).toBeUndefined();
        });
    });

    describe("POST /process/:id/select", () => {
        it("vuelve a un proceso anterior sin tocar sus datos", async () => {
            const primero = await createProcess("Rol A");
            await app.request.post("/candidates").send({ name: "Candidata A" });
            await createProcess("Rol B");

            // Estando en B, los candidatos de A no se ven.
            expect((await app.request.get("/candidates")).body).toEqual([]);

            const res = await app.request.post(`/process/${primero.id}/select`);
            expect(res.status).toBe(200);
            expect(res.body.id).toBe(primero.id);
            expect(res.body.isCurrent).toBe(true);

            const candidates = await app.request.get("/candidates");
            expect(candidates.body).toHaveLength(1);
            expect(candidates.body[0].name).toBe("Candidata A");

            const events = eventsByAction(app.db, "process.selected");
            expect(events).toHaveLength(1);
            expect(events[0].entity_id).toBe(primero.id);
        });

        it("es idempotente: reseleccionar el actual no audita", async () => {
            const proceso = await createProcess();
            const res = await app.request.post(`/process/${proceso.id}/select`);
            expect(res.status).toBe(200);
            expect(eventsByAction(app.db, "process.selected")).toHaveLength(0);
        });

        it("devuelve 404 con un id válido inexistente y 400 con uno malformado", async () => {
            await createProcess();
            expect(
                (await app.request.post(`/process/${newId()}/select`)).status,
            ).toBe(404);
            const invalid = await app.request.post("/process/no-es-uuid/select");
            expect(invalid.status).toBe(400);
            expect(invalid.body.error.code).toBe("INVALID_INPUT");
        });
    });

    describe("PATCH /process", () => {
        it("edita roleTitle y roleContext del proceso activo", async () => {
            await createProcess();
            const res = await app.request
                .patch("/process")
                .send({ roleTitle: "Rol editado", roleContext: null });
            expect(res.status).toBe(200);
            expect(res.body.roleTitle).toBe("Rol editado");
            expect(res.body.roleContext).toBeNull();

            const events = eventsByAction(app.db, "process.updated");
            expect(events).toHaveLength(1);
            expect(JSON.parse(events[0].metadata as string)).toEqual({
                roleTitleChanged: true,
                roleContextChanged: true,
            });
        });

        it("rechaza un roleContext de más de 10.000 caracteres", async () => {
            await createProcess();
            const res = await app.request
                .patch("/process")
                .send({ roleContext: "x".repeat(10_001) });
            expect(res.status).toBe(400);
            expect(res.body.error.code).toBe("INVALID_INPUT");
        });

        it("rechaza un PATCH sin campos editables", async () => {
            await createProcess();
            const res = await app.request.patch("/process").send({});
            expect(res.status).toBe(400);
            expect(res.body.error.code).toBe("INVALID_INPUT");
        });

        it("devuelve 404 si no hay proceso activo", async () => {
            const res = await app.request
                .patch("/process")
                .send({ roleTitle: "X" });
            expect(res.status).toBe(404);
            expect(res.body.error.code).toBe("NOT_FOUND");
        });
    });

    describe("POST /process/close y DELETE /process", () => {
        /** Siembra un proceso con candidato + score + pregunta. */
        async function seedFullProcess() {
            const process = await createProcess();
            const candidateRes = await app.request
                .post("/candidates")
                .send({ name: "Candidata Uno" });
            expect(candidateRes.status).toBe(201);
            const candidateId = candidateRes.body.id as string;

            app.db
                .prepare(
                    `INSERT INTO candidate_score (id, candidate_id, adaptability, final_score)
                     VALUES (?, ?, 4, 4.0)`,
                )
                .run(newId(), candidateId);
            app.db
                .prepare(
                    `INSERT INTO interview_question (id, candidate_id, criterion, dimension, question)
                     VALUES (?, ?, 'adaptability', 'aprendizaje', '¿Pregunta?')`,
                )
                .run(newId(), candidateId);

            return { processId: process.id, candidateId };
        }

        it("close ARCHIVA el proceso conservando todos sus datos", async () => {
            const { processId } = await seedFullProcess();
            const res = await app.request.post("/process/close");
            expect(res.status).toBe(200);
            expect(res.body).toMatchObject({
                id: processId,
                status: "closed",
                isCurrent: true,
            });
            expect(typeof res.body.closedAt).toBe("string");

            // Nada se borra: ese es el cambio respecto al comportamiento viejo.
            expect(countRows(app.db, "process")).toBe(1);
            expect(countRows(app.db, "candidate")).toBe(1);
            expect(countRows(app.db, "candidate_score")).toBe(1);
            expect(countRows(app.db, "interview_question")).toBe(1);

            const events = eventsByAction(app.db, "process.closed");
            expect(events).toHaveLength(1);
            expect(events[0].entity_id).toBe(processId);
            expect(JSON.parse(events[0].metadata as string)).toEqual({
                dataRetained: true,
            });
            expect(events[0].metadata).not.toContain("Candidata");
        });

        it("un proceso archivado se consulta pero no se modifica", async () => {
            const { candidateId } = await seedFullProcess();
            await app.request.post("/process/close");

            // Lecturas: siguen funcionando.
            expect((await app.request.get("/candidates")).status).toBe(200);
            expect(
                (await app.request.get(`/candidates/${candidateId}`)).status,
            ).toBe(200);
            expect((await app.request.get("/ranking")).status).toBe(200);

            // Escrituras: PROCESS_CLOSED (409) en todas las vías de entrada.
            const writes = [
                app.request.post("/candidates").send({ name: "Nueva" }),
                app.request.patch("/process").send({ roleTitle: "Otro" }),
                app.request
                    .patch(`/candidates/${candidateId}`)
                    .send({ name: "Renombrada" }),
                app.request.delete(`/candidates/${candidateId}`),
                app.request.post(`/candidates/${candidateId}/analyze`),
                app.request
                    .patch(`/candidates/${candidateId}/score`)
                    .send({ adaptability: 4 }),
                app.request
                    .post(`/candidates/${candidateId}/notes`)
                    .send({ notes: "nota" }),
                app.request.post(`/candidates/${candidateId}/questions`).send({}),
            ];
            for (const res of await Promise.all(writes)) {
                expect(res.status).toBe(409);
                expect(res.body.error.code).toBe("PROCESS_CLOSED");
            }
            expect(countRows(app.db, "candidate")).toBe(1);
        });

        it("close sobre un proceso ya archivado devuelve 409", async () => {
            await seedFullProcess();
            expect((await app.request.post("/process/close")).status).toBe(200);
            const again = await app.request.post("/process/close");
            expect(again.status).toBe(409);
            expect(again.body.error.code).toBe("PROCESS_CLOSED");
        });

        it("reopen devuelve el proceso archivado a escritura", async () => {
            const { processId } = await seedFullProcess();
            await app.request.post("/process/close");

            const res = await app.request.post(`/process/${processId}/reopen`);
            expect(res.status).toBe(200);
            expect(res.body).toMatchObject({
                status: "active",
                closedAt: null,
            });
            expect(eventsByAction(app.db, "process.reopened")).toHaveLength(1);

            const created = await app.request
                .post("/candidates")
                .send({ name: "Candidata Dos" });
            expect(created.status).toBe(201);
        });

        it("close sin proceso seleccionado devuelve 404", async () => {
            const res = await app.request.post("/process/close");
            expect(res.status).toBe(404);
        });

        it("DELETE /process sigue exigiendo confirmación y purga en cascada", async () => {
            const { processId } = await seedFullProcess();

            for (const payload of [
                {},
                { confirmDelete: false },
                { confirmDelete: "true" },
                { confirmDelete: 1 },
            ]) {
                const res = await app.request.delete("/process").send(payload);
                expect(res.status).toBe(400);
                expect(res.body.error.code).toBe("INVALID_INPUT");
            }
            expect(countRows(app.db, "candidate")).toBe(1);

            const res = await app.request
                .delete("/process")
                .send({ confirmDelete: true });
            expect(res.status).toBe(200);
            expect(res.body).toEqual({
                deleted: true,
                // Sin entrevistas grabadas en este proceso (§24).
                recordings: 0,
                candidatesDeleted: 1,
                scoresDeleted: 1,
                questionsDeleted: 1,
            });
            expect(countRows(app.db, "process")).toBe(0);
            expect(countRows(app.db, "candidate")).toBe(0);
            expect(countRows(app.db, "candidate_score")).toBe(0);
            expect(countRows(app.db, "interview_question")).toBe(0);

            const events = eventsByAction(app.db, "process.deleted");
            expect(events).toHaveLength(1);
            expect(events[0].entity_id).toBe(processId);
            expect(events[0].metadata).not.toContain("Candidata");
        });

        it("DELETE /process/:id borra uno concreto sin tocar el resto", async () => {
            const primero = await createProcess("Rol A");
            await app.request.post("/candidates").send({ name: "Candidata A" });
            const segundo = await createProcess("Rol B");

            const res = await app.request
                .delete(`/process/${primero.id}`)
                .send({ confirmDelete: true });
            expect(res.status).toBe(200);
            expect(res.body.candidatesDeleted).toBe(1);

            expect(countRows(app.db, "process")).toBe(1);
            expect(countRows(app.db, "candidate")).toBe(0);
            const current = await app.request.get("/process");
            expect(current.body.id).toBe(segundo.id);
        });

        it("borrar el seleccionado deja seleccionado otro y no un hueco", async () => {
            const primero = await createProcess("Rol A");
            await createProcess("Rol B");

            const res = await app.request
                .delete("/process")
                .send({ confirmDelete: true });
            expect(res.status).toBe(200);

            const current = await app.request.get("/process");
            expect(current.status).toBe(200);
            expect(current.body.id).toBe(primero.id);
            expect(current.body.isCurrent).toBe(true);
        });

        it("borrar el último proceso deja la app sin proceso seleccionado", async () => {
            await createProcess();
            await app.request.delete("/process").send({ confirmDelete: true });
            expect((await app.request.get("/process")).status).toBe(404);
            expect((await app.request.get("/process/list")).body).toEqual([]);
        });
    });
});
