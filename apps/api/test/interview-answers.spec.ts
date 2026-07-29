import supertest from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Database } from "../src/db/database";
import { newId } from "../src/shared/ids";
import { createTestApp, eventsByAction, resetDb, TestApp } from "./app-helpers";

/**
 * Integración de PATCH /candidates/:id/questions/:questionId/answer sobre la
 * app real (sin LLM): nota 1-10 y notas privadas de la respuesta, agregados
 * de entrevista recalculados y desempate del ranking por entrevista.
 */

/** Texto centinela: nunca puede aparecer en la auditoría. */
const SENTINEL_ANSWER = "RESPUESTA-PRIVADA-CENTINELA-42";

describe("PATCH /candidates/:id/questions/:questionId/answer", () => {
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

    /** Inserta una pregunta persistida (el LLM no interviene en estos tests). */
    function seedQuestion(candidateId: string, criterion: string): string {
        const id = newId();
        db.prepare(
            `INSERT INTO interview_question (id, candidate_id, criterion, dimension, question)
             VALUES (?, ?, ?, 'velocidad', ?)`,
        ).run(id, candidateId, criterion, `Pregunta de ${criterion}`);
        return id;
    }

    function questionRow(questionId: string): {
        answer_score: number | null;
        answer_notes: string | null;
        answered_at: string | null;
    } {
        return db
            .prepare(
                "SELECT answer_score, answer_notes, answered_at FROM interview_question WHERE id = ?",
            )
            .get(questionId) as {
            answer_score: number | null;
            answer_notes: string | null;
            answered_at: string | null;
        };
    }

    describe("camino feliz", () => {
        it("200 con nota y notas privadas; devuelve la pregunta y los agregados", async () => {
            await createProcess();
            const candidateId = await createCandidate();
            const questionId = seedQuestion(candidateId, "adaptability");
            seedQuestion(candidateId, "stack");

            const res = await request
                .patch(
                    `/candidates/${candidateId}/questions/${questionId}/answer`,
                )
                .send({ score: 8, notes: SENTINEL_ANSWER });

            expect(res.status).toBe(200);
            expect(res.body.candidateId).toBe(candidateId);
            expect(res.body.question).toMatchObject({
                id: questionId,
                criterion: "adaptability",
                answerScore: 8,
                answerNotes: SENTINEL_ANSWER,
            });
            expect(typeof res.body.question.answeredAt).toBe("string");

            // Solo adaptabilidad puntuada: el peso se renormaliza a 1.
            expect(res.body.interview).toEqual({
                byCriterion: {
                    adaptability: { average: 8, answered: 1 },
                    fundamentals: null,
                    depth: null,
                    production: null,
                    stack: null,
                },
                overall: 8,
                answeredCount: 1,
                totalCount: 2,
            });

            const row = questionRow(questionId);
            expect(row.answer_score).toBe(8);
            expect(row.answer_notes).toBe(SENTINEL_ANSWER);
            expect(row.answered_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
        });

        it("renormaliza el global al puntuar un segundo criterio", async () => {
            await createProcess();
            const candidateId = await createCandidate();
            const adaptability = seedQuestion(candidateId, "adaptability");
            const stack = seedQuestion(candidateId, "stack");

            await request
                .patch(
                    `/candidates/${candidateId}/questions/${adaptability}/answer`,
                )
                .send({ score: 8 })
                .expect(200);
            const res = await request
                .patch(`/candidates/${candidateId}/questions/${stack}/answer`)
                .send({ score: 4 });

            // (8*0.30 + 4*0.10) / 0.40 = 7.0
            expect(res.status).toBe(200);
            expect(res.body.interview.overall).toBe(7);
            expect(res.body.interview.answeredCount).toBe(2);
            expect(res.body.interview.byCriterion.stack).toEqual({
                average: 4,
                answered: 1,
            });
        });

        it("acepta los extremos del rango (1 y 10)", async () => {
            await createProcess();
            const candidateId = await createCandidate();
            const questionId = seedQuestion(candidateId, "depth");

            for (const score of [1, 10]) {
                const res = await request
                    .patch(
                        `/candidates/${candidateId}/questions/${questionId}/answer`,
                    )
                    .send({ score });
                expect(res.status).toBe(200);
                expect(res.body.question.answerScore).toBe(score);
            }
        });

        it('notes reemplaza el texto anterior y "" lo vacía sin tocar la nota', async () => {
            await createProcess();
            const candidateId = await createCandidate();
            const questionId = seedQuestion(candidateId, "production");
            const url = `/candidates/${candidateId}/questions/${questionId}/answer`;

            await request.patch(url).send({ score: 6, notes: "Primera" });
            const replaced = await request
                .patch(url)
                .send({ notes: "Segunda" });
            expect(replaced.status).toBe(200);
            expect(replaced.body.question.answerNotes).toBe("Segunda");
            // La nota numérica no se toca al enviar solo notes.
            expect(replaced.body.question.answerScore).toBe(6);

            const cleared = await request.patch(url).send({ notes: "" });
            expect(cleared.status).toBe(200);
            expect(cleared.body.question.answerNotes).toBeNull();
            expect(cleared.body.question.answerScore).toBe(6);
            // Sigue respondida: conserva answered_at porque tiene nota.
            expect(cleared.body.question.answeredAt).not.toBeNull();
        });

        it("score:null borra la nota y el candidato vuelve a quedar sin agregados", async () => {
            await createProcess();
            const candidateId = await createCandidate();
            const questionId = seedQuestion(candidateId, "fundamentals");
            const url = `/candidates/${candidateId}/questions/${questionId}/answer`;

            await request.patch(url).send({ score: 9 }).expect(200);
            const res = await request.patch(url).send({ score: null });

            expect(res.status).toBe(200);
            expect(res.body.question.answerScore).toBeNull();
            expect(res.body.interview.overall).toBeNull();
            expect(res.body.interview.answeredCount).toBe(0);
            expect(res.body.interview.byCriterion.fundamentals).toBeNull();
            // Sin nota y sin texto: deja de estar respondida.
            expect(res.body.question.answeredAt).toBeNull();
            expect(questionRow(questionId).answered_at).toBeNull();
        });
    });

    describe("validaciones", () => {
        it.each([[0], [11], [-3], [5.5], ["8"], [true]])(
            "score inválido (%s) responde 400 INVALID_INPUT y no persiste",
            async (score) => {
                await createProcess();
                const candidateId = await createCandidate();
                const questionId = seedQuestion(candidateId, "adaptability");

                const res = await request
                    .patch(
                        `/candidates/${candidateId}/questions/${questionId}/answer`,
                    )
                    .send({ score });
                expect(res.status).toBe(400);
                expect(res.body.error.code).toBe("INVALID_INPUT");
                expect(questionRow(questionId).answer_score).toBeNull();
            },
        );

        it("notes no textual, body vacío o campo desconocido responden 400", async () => {
            await createProcess();
            const candidateId = await createCandidate();
            const questionId = seedQuestion(candidateId, "adaptability");
            const url = `/candidates/${candidateId}/questions/${questionId}/answer`;

            for (const body of [
                { notes: 12 },
                {},
                { score: 5, comentario: "x" },
                { answerScore: 5 },
            ]) {
                const res = await request.patch(url).send(body);
                expect(res.status).toBe(400);
                expect(res.body.error.code).toBe("INVALID_INPUT");
            }
        });

        it("ids no UUID responden 400 (ambos parámetros se validan)", async () => {
            await createProcess();
            const candidateId = await createCandidate();
            const questionId = seedQuestion(candidateId, "adaptability");

            const badCandidate = await request
                .patch(`/candidates/no-uuid/questions/${questionId}/answer`)
                .send({ score: 5 });
            expect(badCandidate.status).toBe(400);
            expect(badCandidate.body.error.code).toBe("INVALID_INPUT");

            const badQuestion = await request
                .patch(`/candidates/${candidateId}/questions/123/answer`)
                .send({ score: 5 });
            expect(badQuestion.status).toBe(400);
            expect(badQuestion.body.error.code).toBe("INVALID_INPUT");
        });

        it("pregunta de OTRO candidato responde 404 y no la modifica", async () => {
            await createProcess();
            const owner = await createCandidate("Dueña");
            const other = await createCandidate("Ajena");
            const questionId = seedQuestion(owner, "adaptability");

            const res = await request
                .patch(`/candidates/${other}/questions/${questionId}/answer`)
                .send({ score: 10 });

            expect(res.status).toBe(404);
            expect(res.body.error.code).toBe("NOT_FOUND");
            expect(questionRow(questionId).answer_score).toBeNull();
        });

        it("pregunta inexistente, candidato inexistente o sin proceso activo → 404", async () => {
            await createProcess();
            const candidateId = await createCandidate();
            const questionId = seedQuestion(candidateId, "adaptability");

            const missingQuestion = await request
                .patch(`/candidates/${candidateId}/questions/${newId()}/answer`)
                .send({ score: 5 });
            expect(missingQuestion.status).toBe(404);

            const missingCandidate = await request
                .patch(`/candidates/${newId()}/questions/${questionId}/answer`)
                .send({ score: 5 });
            expect(missingCandidate.status).toBe(404);

            resetDb(db);
            const noProcess = await request
                .patch(`/candidates/${newId()}/questions/${newId()}/answer`)
                .send({ score: 5 });
            expect(noProcess.status).toBe(404);
        });
    });

    describe("auditoría (§17: nunca contenido)", () => {
        it("registra question.answered con ids y longitudes, sin el texto", async () => {
            await createProcess();
            const candidateId = await createCandidate();
            const questionId = seedQuestion(candidateId, "adaptability");

            await request
                .patch(
                    `/candidates/${candidateId}/questions/${questionId}/answer`,
                )
                .send({ score: 7, notes: SENTINEL_ANSWER })
                .expect(200);

            const events = eventsByAction(db, "question.answered");
            expect(events).toHaveLength(1);
            expect(events[0].entity_type).toBe("interview_question");
            expect(events[0].entity_id).toBe(questionId);
            const metadata = JSON.parse(events[0].metadata as string);
            expect(metadata).toEqual({
                candidateId,
                hasScore: true,
                notesLength: SENTINEL_ANSWER.length,
            });
            expect(events[0].metadata).not.toContain(SENTINEL_ANSWER);
        });
    });

    describe("GET /candidates/:id", () => {
        it("devuelve answerScore, answerNotes, answeredAt y el objeto interview", async () => {
            await createProcess();
            const candidateId = await createCandidate();
            const questionId = seedQuestion(candidateId, "adaptability");
            seedQuestion(candidateId, "depth");

            await request
                .patch(
                    `/candidates/${candidateId}/questions/${questionId}/answer`,
                )
                .send({ score: 9, notes: SENTINEL_ANSWER })
                .expect(200);

            const res = await request.get(`/candidates/${candidateId}`);
            expect(res.status).toBe(200);
            expect(res.body.questions[0]).toMatchObject({
                id: questionId,
                answerScore: 9,
                answerNotes: SENTINEL_ANSWER,
            });
            expect(res.body.questions[1]).toMatchObject({
                answerScore: null,
                answerNotes: null,
                answeredAt: null,
            });
            expect(res.body.interview).toEqual({
                byCriterion: {
                    adaptability: { average: 9, answered: 1 },
                    fundamentals: null,
                    depth: null,
                    production: null,
                    stack: null,
                },
                overall: 9,
                answeredCount: 1,
                totalCount: 2,
            });
        });

        it("candidato sin preguntas: interview presente y vacío", async () => {
            await createProcess();
            const candidateId = await createCandidate();

            const res = await request.get(`/candidates/${candidateId}`);
            expect(res.status).toBe(200);
            expect(res.body.interview).toEqual({
                byCriterion: {
                    adaptability: null,
                    fundamentals: null,
                    depth: null,
                    production: null,
                    stack: null,
                },
                overall: null,
                answeredCount: 0,
                totalCount: 0,
            });
        });
    });

    describe("GET /ranking: la entrevista desempata (§15)", () => {
        const EQUAL_SCORES = {
            adaptability: 3,
            fundamentals: 3,
            depth: 3,
            production: 3,
            stack: 3,
        };

        async function score(candidateId: string): Promise<void> {
            await request
                .patch(`/candidates/${candidateId}/score`)
                .send({ ...EQUAL_SCORES, confidence: 0.5 })
                .expect(200);
        }

        async function answer(
            candidateId: string,
            criterion: string,
            value: number,
        ): Promise<void> {
            const questionId = seedQuestion(candidateId, criterion);
            await request
                .patch(
                    `/candidates/${candidateId}/questions/${questionId}/answer`,
                )
                .send({ score: value })
                .expect(200);
        }

        it("mismo score de CV y criterios idénticos: gana la mejor entrevista", async () => {
            await createProcess();
            const weak = await createCandidate("Entrevista Floja");
            const strong = await createCandidate("Entrevista Fuerte");
            await score(weak);
            await score(strong);
            await answer(weak, "adaptability", 4);
            await answer(strong, "adaptability", 9);

            const res = await request.get("/ranking");
            expect(res.status).toBe(200);
            expect(
                res.body.entries.map((e: { name: string }) => e.name),
            ).toEqual(["Entrevista Fuerte", "Entrevista Floja"]);
            expect(res.body.entries[0]).toMatchObject({
                finalScore: 3,
                interviewScore: 9,
                tieBreakApplied: "interview",
                needsManualReview: false,
            });
            expect(res.body.entries[1].tieBreakApplied).toBe("interview");
            expect(res.body.entries[0].interviewByCriterion).toEqual({
                adaptability: { average: 9, answered: 1 },
                fundamentals: null,
                depth: null,
                production: null,
                stack: null,
            });
        });

        it("un candidato sin entrevista puntuada queda por detrás (null = 0)", async () => {
            await createProcess();
            const none = await createCandidate("Sin Entrevista");
            const some = await createCandidate("Con Entrevista");
            await score(none);
            await score(some);
            // Nota mínima posible: aun así basta para adelantar a quien no
            // tiene ninguna evidencia de entrevista.
            await answer(some, "stack", 1);

            const res = await request.get("/ranking");
            expect(
                res.body.entries.map((e: { name: string }) => e.name),
            ).toEqual(["Con Entrevista", "Sin Entrevista"]);
            expect(res.body.entries[0].interviewScore).toBe(1);
            expect(res.body.entries[1].interviewScore).toBeNull();
            expect(res.body.entries[0].tieBreakApplied).toBe("interview");
        });

        it("la entrevista NO altera el score final ni el orden por score", async () => {
            await createProcess();
            const better = await createCandidate("Mejor CV");
            const worse = await createCandidate("Peor CV");
            await request
                .patch(`/candidates/${better}/score`)
                .send({
                    adaptability: 5,
                    fundamentals: 5,
                    depth: 5,
                    production: 5,
                    stack: 5,
                })
                .expect(200);
            await score(worse);
            // El de peor CV tiene la mejor entrevista: no adelanta.
            await answer(worse, "adaptability", 10);

            const res = await request.get("/ranking");
            expect(
                res.body.entries.map((e: { name: string }) => e.name),
            ).toEqual(["Mejor CV", "Peor CV"]);
            expect(res.body.entries[0].finalScore).toBe(5);
            expect(res.body.entries[0].tieBreakApplied).toBeNull();
            expect(res.body.entries[1].interviewScore).toBe(10);
        });

        it("empate también en entrevista: sigue desempatando la confianza", async () => {
            await createProcess();
            const low = await createCandidate("Menos Confianza");
            const high = await createCandidate("Más Confianza");
            await request
                .patch(`/candidates/${low}/score`)
                .send({ ...EQUAL_SCORES, confidence: 0.2 })
                .expect(200);
            await request
                .patch(`/candidates/${high}/score`)
                .send({ ...EQUAL_SCORES, confidence: 0.8 })
                .expect(200);
            await answer(low, "adaptability", 7);
            await answer(high, "adaptability", 7);

            const res = await request.get("/ranking");
            expect(
                res.body.entries.map((e: { name: string }) => e.name),
            ).toEqual(["Más Confianza", "Menos Confianza"]);
            expect(res.body.entries[0].tieBreakApplied).toBe("confidence");
        });
    });
});
