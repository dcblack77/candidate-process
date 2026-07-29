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

        it("devuelve 409 ACTIVE_PROCESS_EXISTS si ya hay un proceso activo", async () => {
            await createProcess();
            const res = await app.request
                .post("/process")
                .send({ roleTitle: "Otro rol" });
            expect(res.status).toBe(409);
            expect(res.body.error.code).toBe("ACTIVE_PROCESS_EXISTS");
            expect(countRows(app.db, "process")).toBe(1);
        });

        it("la DB también impide un segundo proceso activo (índice único parcial)", () => {
            app.db
                .prepare("INSERT INTO process (id, role_title) VALUES (?, ?)")
                .run(newId(), "Rol A");
            expect(() =>
                app.db
                    .prepare(
                        "INSERT INTO process (id, role_title) VALUES (?, ?)",
                    )
                    .run(newId(), "Rol B"),
            ).toThrow(/UNIQUE/);
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

        it("close sin confirmDelete devuelve 400 y no borra nada", async () => {
            await seedFullProcess();
            for (const payload of [
                {},
                { confirmDelete: false },
                { confirmDelete: "true" },
                { confirmDelete: 1 },
            ]) {
                const res = await app.request
                    .post("/process/close")
                    .send(payload);
                expect(res.status).toBe(400);
                expect(res.body.error.code).toBe("INVALID_INPUT");
            }
            expect(countRows(app.db, "process")).toBe(1);
            expect(countRows(app.db, "candidate")).toBe(1);
            expect(countRows(app.db, "candidate_score")).toBe(1);
            expect(countRows(app.db, "interview_question")).toBe(1);
        });

        it("close con confirmDelete purga candidatos, scores y preguntas en cascada", async () => {
            const { processId } = await seedFullProcess();
            const res = await app.request
                .post("/process/close")
                .send({ confirmDelete: true });
            expect(res.status).toBe(200);
            expect(res.body).toEqual({
                deleted: true,
                candidatesDeleted: 1,
                scoresDeleted: 1,
                questionsDeleted: 1,
            });

            // Todo el proceso desaparece; solo queda la traza en app_event.
            expect(countRows(app.db, "process")).toBe(0);
            expect(countRows(app.db, "candidate")).toBe(0);
            expect(countRows(app.db, "candidate_score")).toBe(0);
            expect(countRows(app.db, "interview_question")).toBe(0);

            const events = eventsByAction(app.db, "process.closed");
            expect(events).toHaveLength(1);
            expect(events[0].entity_id).toBe(processId);
            expect(JSON.parse(events[0].metadata as string)).toEqual({
                candidatesDeleted: 1,
                scoresDeleted: 1,
                questionsDeleted: 1,
            });
            // Sin datos sensibles en la traza: ni nombres ni contenidos.
            expect(events[0].metadata).not.toContain("Candidata");

            const after = await app.request.get("/process");
            expect(after.status).toBe(404);
        });

        it("close sin proceso activo devuelve 404", async () => {
            const res = await app.request
                .post("/process/close")
                .send({ confirmDelete: true });
            expect(res.status).toBe(404);
        });

        it("DELETE /process exige la misma confirmación y purga en cascada", async () => {
            const { processId } = await seedFullProcess();

            const noConfirm = await app.request.delete("/process").send({});
            expect(noConfirm.status).toBe(400);
            expect(noConfirm.body.error.code).toBe("INVALID_INPUT");

            const res = await app.request
                .delete("/process")
                .send({ confirmDelete: true });
            expect(res.status).toBe(200);
            expect(res.body.deleted).toBe(true);
            expect(countRows(app.db, "process")).toBe(0);
            expect(countRows(app.db, "candidate")).toBe(0);

            const events = eventsByAction(app.db, "process.deleted");
            expect(events).toHaveLength(1);
            expect(events[0].entity_id).toBe(processId);
        });
    });
});
