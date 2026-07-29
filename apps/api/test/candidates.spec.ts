import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MAX_CANDIDATES_PER_PROCESS } from "../src/shared/limits";
import { newId } from "../src/shared/ids";
import {
    countRows,
    createTestApp,
    eventsByAction,
    resetDb,
    TestApp,
} from "./app-helpers";

/**
 * Integración del dominio Candidates sobre la app real (supertest + :memory:).
 */
describe("Candidates API", () => {
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

    async function createProcess(): Promise<string> {
        const res = await app.request
            .post("/process")
            .send({ roleTitle: "Backend" });
        expect(res.status).toBe(201);
        return res.body.id as string;
    }

    async function createCandidate(name = "Ada Lovelace"): Promise<string> {
        const res = await app.request.post("/candidates").send({ name });
        expect(res.status).toBe(201);
        return res.body.id as string;
    }

    describe("sin proceso activo", () => {
        it("POST /candidates devuelve 404 NOT_FOUND", async () => {
            const res = await app.request
                .post("/candidates")
                .send({ name: "Alguien" });
            expect(res.status).toBe(404);
            expect(res.body.error.code).toBe("NOT_FOUND");
            expect(countRows(app.db, "candidate")).toBe(0);
        });

        it("GET /candidates devuelve 404 NOT_FOUND", async () => {
            const res = await app.request.get("/candidates");
            expect(res.status).toBe(404);
            expect(res.body.error.code).toBe("NOT_FOUND");
        });
    });

    describe("POST /candidates", () => {
        it("crea el candidato en el proceso activo y lo audita", async () => {
            const processId = await createProcess();
            const res = await app.request
                .post("/candidates")
                .send({ name: "Grace Hopper" });
            expect(res.status).toBe(201);
            expect(res.body).toMatchObject({
                name: "Grace Hopper",
                analysisStatus: "pending",
            });
            expect(typeof res.body.id).toBe("string");
            expect(typeof res.body.createdAt).toBe("string");

            const events = eventsByAction(app.db, "candidate.created");
            expect(events).toHaveLength(1);
            expect(events[0].entity_id).toBe(res.body.id);
            const metadata = JSON.parse(events[0].metadata as string);
            expect(metadata).toEqual({ processId, candidateCount: 1 });
            // La auditoría no guarda el nombre (dato personal).
            expect(events[0].metadata).not.toContain("Grace");
        });

        it("rechaza name vacío o no string con INVALID_INPUT", async () => {
            await createProcess();
            for (const body of [
                {},
                { name: "" },
                { name: "   " },
                { name: 42 },
            ]) {
                const res = await app.request.post("/candidates").send(body);
                expect(res.status).toBe(400);
                expect(res.body.error.code).toBe("INVALID_INPUT");
            }
            expect(countRows(app.db, "candidate")).toBe(0);
        });

        it("devuelve LIMIT_EXCEEDED al superar los 100 candidatos no borrados", async () => {
            const processId = await createProcess();
            const insert = app.db.prepare(
                "INSERT INTO candidate (id, process_id, name) VALUES (?, ?, ?)",
            );
            const fill = app.db.transaction(() => {
                for (let i = 0; i < MAX_CANDIDATES_PER_PROCESS; i++) {
                    insert.run(newId(), processId, `Candidato ${i}`);
                }
            });
            fill();

            const res = await app.request
                .post("/candidates")
                .send({ name: "Uno más" });
            expect(res.status).toBe(422);
            expect(res.body.error.code).toBe("LIMIT_EXCEEDED");

            // Los soft-deleted no cuentan para el límite.
            const anyId = (
                app.db.prepare("SELECT id FROM candidate LIMIT 1").get() as {
                    id: string;
                }
            ).id;
            await app.request.delete(`/candidates/${anyId}`);
            const retry = await app.request
                .post("/candidates")
                .send({ name: "Uno más" });
            expect(retry.status).toBe(201);
        });
    });

    describe("GET /candidates", () => {
        it("lista id, name, analysisStatus y createdAt de los no borrados", async () => {
            await createProcess();
            const id = await createCandidate("Alan Turing");
            const res = await app.request.get("/candidates");
            expect(res.status).toBe(200);
            expect(res.body).toHaveLength(1);
            expect(res.body[0]).toEqual({
                id,
                name: "Alan Turing",
                analysisStatus: "pending",
                createdAt: expect.any(String),
            });
        });
    });

    describe("GET /candidates/:id", () => {
        it("valida el formato del id (INVALID_INPUT)", async () => {
            await createProcess();
            for (const bad of ["abc", "123", "not-a-uuid-0000"]) {
                const res = await app.request.get(`/candidates/${bad}`);
                expect(res.status).toBe(400);
                expect(res.body.error.code).toBe("INVALID_INPUT");
            }
        });

        it("devuelve 404 si el id (bien formado) no existe", async () => {
            await createProcess();
            const res = await app.request.get(`/candidates/${newId()}`);
            expect(res.status).toBe(404);
            expect(res.body.error.code).toBe("NOT_FOUND");
        });

        it("devuelve 404 si el candidato pertenece a otro proceso", async () => {
            // Proceso cerrado previo con un candidato, insertados directamente.
            const oldProcessId = newId();
            app.db
                .prepare(
                    "INSERT INTO process (id, role_title, status, closed_at) VALUES (?, 'Antiguo', 'closed', '2026-01-01T00:00:00Z')",
                )
                .run(oldProcessId);
            const strayId = newId();
            app.db
                .prepare(
                    "INSERT INTO candidate (id, process_id, name) VALUES (?, ?, 'Ajeno')",
                )
                .run(strayId, oldProcessId);

            await createProcess();
            const res = await app.request.get(`/candidates/${strayId}`);
            expect(res.status).toBe(404);
        });

        it("devuelve el detalle con cv_summary/cv_evidence parseados a JSON", async () => {
            const processId = await createProcess();
            const id = await createCandidate();
            app.db
                .prepare(
                    "UPDATE candidate SET cv_summary = ?, cv_evidence = ?, analysis_status = 'summarized' WHERE id = ?",
                )
                .run(
                    JSON.stringify({ professional_summary: "Resumen" }),
                    JSON.stringify({
                        adaptability: [{ text: "Evidencia", type: "explicit" }],
                    }),
                    id,
                );

            const res = await app.request.get(`/candidates/${id}`);
            expect(res.status).toBe(200);
            expect(res.body).toMatchObject({
                id,
                processId,
                name: "Ada Lovelace",
                analysisStatus: "summarized",
                cvSummary: { professional_summary: "Resumen" },
                cvEvidence: {
                    adaptability: [{ text: "Evidencia", type: "explicit" }],
                },
            });
            expect(typeof res.body.updatedAt).toBe("string");
        });

        it("devuelve cvSummary null cuando aún no hay resumen", async () => {
            await createProcess();
            const id = await createCandidate();
            const res = await app.request.get(`/candidates/${id}`);
            expect(res.status).toBe(200);
            expect(res.body.cvSummary).toBeNull();
            expect(res.body.cvEvidence).toBeNull();
        });
    });

    describe("PATCH /candidates/:id", () => {
        it("renombra al candidato, refresca updated_at y lo audita", async () => {
            await createProcess();
            const id = await createCandidate("Nombre Original");
            // Forzamos un updated_at antiguo para comprobar el refresco.
            app.db
                .prepare(
                    "UPDATE candidate SET updated_at = '2020-01-01T00:00:00.000Z' WHERE id = ?",
                )
                .run(id);

            const res = await app.request
                .patch(`/candidates/${id}`)
                .send({ name: "Nombre Nuevo" });
            expect(res.status).toBe(200);
            expect(res.body.name).toBe("Nombre Nuevo");

            const row = app.db
                .prepare("SELECT name, updated_at FROM candidate WHERE id = ?")
                .get(id) as { name: string; updated_at: string };
            expect(row.name).toBe("Nombre Nuevo");
            expect(row.updated_at).not.toBe("2020-01-01T00:00:00.000Z");

            const events = eventsByAction(app.db, "candidate.renamed");
            expect(events).toHaveLength(1);
            expect(events[0].entity_id).toBe(id);
            // Sin nombres en la auditoría.
            expect(events[0].metadata ?? "").not.toContain("Nombre");
        });

        it("rechaza id malformado y name inválido", async () => {
            await createProcess();
            const id = await createCandidate();
            const badId = await app.request
                .patch("/candidates/nope")
                .send({ name: "X" });
            expect(badId.status).toBe(400);
            const badName = await app.request
                .patch(`/candidates/${id}`)
                .send({ name: "" });
            expect(badName.status).toBe(400);
        });
    });

    describe("DELETE /candidates/:id (soft delete)", () => {
        it("marca deleted_at, deja de listarse y su detalle pasa a 404", async () => {
            await createProcess();
            const id = await createCandidate();

            const res = await app.request.delete(`/candidates/${id}`);
            expect(res.status).toBe(200);
            expect(res.body).toEqual({ id, deleted: true });

            // La fila sigue existiendo (borrado lógico) con deleted_at.
            const row = app.db
                .prepare("SELECT deleted_at FROM candidate WHERE id = ?")
                .get(id) as { deleted_at: string | null };
            expect(row.deleted_at).not.toBeNull();

            const list = await app.request.get("/candidates");
            expect(list.status).toBe(200);
            expect(list.body).toEqual([]);

            const detail = await app.request.get(`/candidates/${id}`);
            expect(detail.status).toBe(404);

            // Borrarlo dos veces también es 404.
            const again = await app.request.delete(`/candidates/${id}`);
            expect(again.status).toBe(404);

            const events = eventsByAction(app.db, "candidate.deleted");
            expect(events).toHaveLength(1);
            expect(events[0].entity_id).toBe(id);
            expect(JSON.parse(events[0].metadata as string)).toMatchObject({
                softDelete: true,
            });
        });

        it("valida el formato del id", async () => {
            await createProcess();
            const res = await app.request.delete("/candidates/malformed-id");
            expect(res.status).toBe(400);
            expect(res.body.error.code).toBe("INVALID_INPUT");
        });
    });
});
