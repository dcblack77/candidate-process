import supertest from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Database } from "../src/db/database";
import { newId } from "../src/shared/ids";
import { createTestApp, eventsByAction, resetDb, TestApp } from "./app-helpers";

/**
 * Integración de PATCH /candidates/:id/score y POST /candidates/:id/notes
 * sobre la app real (sin LLM: la edición manual no toca el modelo).
 */

describe("PATCH /candidates/:id/score y POST /candidates/:id/notes", () => {
    let app: TestApp;
    let db: Database;
    let request: ReturnType<typeof supertest>;

    beforeAll(async () => {
        app = await createTestApp();
        db = app.db;
        request = app.request;
    });

    afterAll(async () => {
        await app.close();
    });

    beforeEach(() => {
        resetDb(db);
    });

    async function createProcess(): Promise<void> {
        await request
            .post("/process")
            .send({ roleTitle: "Backend Serverless" })
            .expect(201);
    }

    async function createCandidate(name = "Ana Ejemplo"): Promise<string> {
        const res = await request.post("/candidates").send({ name });
        expect(res.status).toBe(201);
        return res.body.id as string;
    }

    const FULL_SCORES = {
        adaptability: 5,
        fundamentals: 4,
        depth: 3,
        production: 2,
        stack: 1,
    };

    function scoreRow(
        candidateId: string,
    ): Record<string, unknown> | undefined {
        return db
            .prepare("SELECT * FROM candidate_score WHERE candidate_id = ?")
            .get(candidateId) as Record<string, unknown> | undefined;
    }

    describe("creación sin score previo (decisión: exige los 5 criterios)", () => {
        it("con los 5 criterios crea la fila y calcula finalScore", async () => {
            await createProcess();
            const id = await createCandidate();

            const res = await request
                .patch(`/candidates/${id}/score`)
                .send(FULL_SCORES);

            expect(res.status).toBe(200);
            // 5*0.30 + 4*0.25 + 3*0.20 + 2*0.15 + 1*0.10 = 3.5
            expect(res.body).toMatchObject({
                candidateId: id,
                scores: FULL_SCORES,
                finalScore: 3.5,
                confidence: null,
                manualNotes: null,
            });
            expect(scoreRow(id)).toMatchObject({
                ...FULL_SCORES,
                final_score: 3.5,
            });
        });

        it("parcial sin score previo responde 404 (no hay nada que editar)", async () => {
            await createProcess();
            const id = await createCandidate();

            const res = await request
                .patch(`/candidates/${id}/score`)
                .send({ adaptability: 4 });

            expect(res.status).toBe(404);
            expect(res.body.error.code).toBe("NOT_FOUND");
            expect(scoreRow(id)).toBeUndefined();
        });

        it("solo confidence/manualNotes sin score previo también responde 404", async () => {
            await createProcess();
            const id = await createCandidate();

            const res = await request
                .patch(`/candidates/${id}/score`)
                .send({ confidence: 0.5, manualNotes: "nota" });

            expect(res.status).toBe(404);
        });
    });

    describe("edición parcial con score existente", () => {
        it("recalcula final_score con los valores resultantes", async () => {
            await createProcess();
            const id = await createCandidate();
            await request
                .patch(`/candidates/${id}/score`)
                .send(FULL_SCORES)
                .expect(200);

            const res = await request
                .patch(`/candidates/${id}/score`)
                .send({ adaptability: 1 });

            expect(res.status).toBe(200);
            // 1*0.30 + 4*0.25 + 3*0.20 + 2*0.15 + 1*0.10 = 2.3
            expect(res.body.finalScore).toBe(2.3);
            expect(res.body.scores).toEqual({
                ...FULL_SCORES,
                adaptability: 1,
            });
            expect(scoreRow(id)).toMatchObject({ final_score: 2.3 });
        });

        it("confidence y manualNotes se actualizan sin tocar los criterios", async () => {
            await createProcess();
            const id = await createCandidate();
            await request
                .patch(`/candidates/${id}/score`)
                .send(FULL_SCORES)
                .expect(200);

            const res = await request
                .patch(`/candidates/${id}/score`)
                .send({
                    confidence: 0.85,
                    manualNotes: "Revisar en entrevista",
                });

            expect(res.status).toBe(200);
            expect(res.body).toMatchObject({
                confidence: 0.85,
                manualNotes: "Revisar en entrevista",
                finalScore: 3.5,
                scores: FULL_SCORES,
            });
        });

        it("audita la edición con los nombres de campos, sin contenido", async () => {
            await createProcess();
            const id = await createCandidate();
            await request
                .patch(`/candidates/${id}/score`)
                .send(FULL_SCORES)
                .expect(200);
            await request
                .patch(`/candidates/${id}/score`)
                .send({ depth: 5, manualNotes: "SECRETO-NOTA" })
                .expect(200);

            const events = eventsByAction(db, "candidate.score_edited");
            expect(events.length).toBe(2);
            const metadata = JSON.parse(events[1].metadata as string);
            expect(metadata.fields).toBe("depth,manualNotes");
            expect(JSON.stringify(events)).not.toContain("SECRETO-NOTA");
        });

        it("GET /candidates/:id incluye el score editado", async () => {
            await createProcess();
            const id = await createCandidate();
            await request
                .patch(`/candidates/${id}/score`)
                .send(FULL_SCORES)
                .expect(200);

            const res = await request.get(`/candidates/${id}`);
            expect(res.status).toBe(200);
            expect(res.body.score).toMatchObject({
                candidateId: id,
                scores: FULL_SCORES,
                finalScore: 3.5,
            });
            expect(res.body.questions).toEqual([]);
        });
    });

    describe("validación (400 INVALID_INPUT)", () => {
        it.each([
            [{ adaptability: 0 }],
            [{ adaptability: 6 }],
            [{ fundamentals: 2.5 }],
            [{ depth: "3" }],
            [{ confidence: -0.1 }],
            [{ confidence: 1.5 }],
            [{ manualNotes: 42 }],
            [{ desconocido: 3 }],
            [{}],
        ])("body inválido %j responde 400", async (body) => {
            await createProcess();
            const id = await createCandidate();

            const res = await request
                .patch(`/candidates/${id}/score`)
                .send(body);
            expect(res.status).toBe(400);
            expect(res.body.error.code).toBe("INVALID_INPUT");
        });

        it("candidato inexistente responde 404 y sin proceso activo responde 404", async () => {
            await createProcess();
            const missing = await request
                .patch(`/candidates/${newId()}/score`)
                .send(FULL_SCORES);
            expect(missing.status).toBe(404);

            resetDb(db);
            const noProcess = await request
                .patch(`/candidates/${newId()}/score`)
                .send(FULL_SCORES);
            expect(noProcess.status).toBe(404);
        });
    });

    describe("POST /candidates/:id/notes", () => {
        it("guarda las notas creando la fila de score si no existe", async () => {
            await createProcess();
            const id = await createCandidate();

            const res = await request
                .post(`/candidates/${id}/notes`)
                .send({ notes: "Primera nota privada" });

            expect(res.status).toBe(200);
            expect(res.body).toEqual({ candidateId: id, notesSaved: true });
            expect(scoreRow(id)).toMatchObject({
                manual_notes: "Primera nota privada",
                adaptability: null,
                final_score: null,
            });
        });

        it("REEMPLAZA las notas anteriores (decisión documentada: no es append)", async () => {
            await createProcess();
            const id = await createCandidate();

            await request
                .post(`/candidates/${id}/notes`)
                .send({ notes: "vieja" })
                .expect(200);
            await request
                .post(`/candidates/${id}/notes`)
                .send({ notes: "nueva" })
                .expect(200);

            const row = scoreRow(id) as Record<string, unknown>;
            expect(row.manual_notes).toBe("nueva");
            expect(String(row.manual_notes)).not.toContain("vieja");
        });

        it("audita sin contenido: solo la longitud", async () => {
            await createProcess();
            const id = await createCandidate();
            await request
                .post(`/candidates/${id}/notes`)
                .send({ notes: "CONTENIDO-PRIVADO" })
                .expect(200);

            const events = eventsByAction(db, "candidate.note_saved");
            expect(events).toHaveLength(1);
            expect(JSON.parse(events[0].metadata as string)).toEqual({
                length: "CONTENIDO-PRIVADO".length,
            });
            expect(JSON.stringify(events)).not.toContain("CONTENIDO-PRIVADO");
        });

        it("notes que no es texto responde 400; candidato inexistente 404", async () => {
            await createProcess();
            const id = await createCandidate();

            const invalid = await request
                .post(`/candidates/${id}/notes`)
                .send({ notes: 42 });
            expect(invalid.status).toBe(400);

            const missing = await request
                .post(`/candidates/${newId()}/notes`)
                .send({ notes: "x" });
            expect(missing.status).toBe(404);
        });

        it("un candidato con score conserva sus criterios al guardar notas", async () => {
            await createProcess();
            const id = await createCandidate();
            await request
                .patch(`/candidates/${id}/score`)
                .send(FULL_SCORES)
                .expect(200);
            await request
                .post(`/candidates/${id}/notes`)
                .send({ notes: "ok" })
                .expect(200);

            expect(scoreRow(id)).toMatchObject({
                ...FULL_SCORES,
                final_score: 3.5,
                manual_notes: "ok",
            });
        });
    });
});
