import { Server } from "node:http";
import { createModule, interfaces } from "@expressots/core";
import supertest from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { App } from "../src/app";
import { Database, DB } from "../src/db/database";
import { AppEnv, ENV, loadEnv } from "../src/env";
import { RANKING_RATE_KEY } from "../src/ranking/get-ranking.usecase";
import { WEIGHTS } from "../src/scoring/weights";
import { RateLimiter } from "../src/security/rate-limit";
import { AuditRepository } from "../src/shared/audit";
import { newId } from "../src/shared/ids";
import { RATE_LIMITS_PER_HOUR } from "../src/shared/limits";
import { resetDb } from "./app-helpers";
import { createTestDb } from "./helpers";

/**
 * Integración de GET /ranking sobre la app real: los scores se siembran por
 * la propia API (PATCH /candidates/:id/score), sin LLM.
 */

describe("GET /ranking", () => {
    let db: Database;
    let request: ReturnType<typeof supertest>;
    let server: Server;
    const rateLimiter = new RateLimiter();

    beforeAll(async () => {
        db = createTestDb();
        const TestCoreModule = createModule((bind: interfaces.Bind) => {
            bind<AppEnv>(ENV).toConstantValue(loadEnv());
            bind<Database>(DB).toConstantValue(db);
            bind(AuditRepository).toSelf().inSingletonScope();
            bind(RateLimiter).toConstantValue(rateLimiter);
        });

        const app = new App(TestCoreModule);
        await app.listen(0);
        server = await app.getHttpServer();
        request = supertest(server);
    });

    afterAll(async () => {
        await new Promise<void>((resolve, reject) => {
            server.close((error) => (error ? reject(error) : resolve()));
        });
    });

    beforeEach(() => {
        resetDb(db);
        rateLimiter.reset();
    });

    async function createProcess(): Promise<void> {
        await request
            .post("/process")
            .send({ roleTitle: "Backend Serverless" })
            .expect(201);
    }

    async function createCandidate(name: string): Promise<string> {
        const res = await request.post("/candidates").send({ name });
        expect(res.status).toBe(201);
        return res.body.id as string;
    }

    async function score(
        candidateId: string,
        scores: Record<string, number>,
        confidence?: number,
    ): Promise<void> {
        await request
            .patch(`/candidates/${candidateId}/score`)
            .send(confidence === undefined ? scores : { ...scores, confidence })
            .expect(200);
    }

    it("sin proceso activo responde 404", async () => {
        const res = await request.get("/ranking");
        expect(res.status).toBe(404);
        expect(res.body.error.code).toBe("NOT_FOUND");
    });

    it("proceso vacío: entries y unscored vacíos, weights presentes (única fuente)", async () => {
        await createProcess();
        const res = await request.get("/ranking");

        expect(res.status).toBe(200);
        expect(res.body).toEqual({
            weights: WEIGHTS,
            entries: [],
            unscored: [],
        });
    });

    it("ordena por score final y aplica el desempate por adaptabilidad", async () => {
        await createProcess();
        const top = await createCandidate("Top");
        const tieLoser = await createCandidate("Empate Perdedor");
        const tieWinner = await createCandidate("Empate Ganador");

        await score(top, {
            adaptability: 5,
            fundamentals: 5,
            depth: 5,
            production: 5,
            stack: 5,
        });
        // Ambos con finalScore 3.0; gana la mayor adaptabilidad (4 > 3).
        await score(tieLoser, {
            adaptability: 3,
            fundamentals: 3,
            depth: 3,
            production: 3,
            stack: 3,
        });
        await score(tieWinner, {
            adaptability: 4,
            fundamentals: 3,
            depth: 3,
            production: 1,
            stack: 3,
        });

        const res = await request.get("/ranking");
        expect(res.status).toBe(200);
        expect(res.body.entries.map((e: { name: string }) => e.name)).toEqual([
            "Top",
            "Empate Ganador",
            "Empate Perdedor",
        ]);
        expect(
            res.body.entries.map((e: { position: number }) => e.position),
        ).toEqual([1, 2, 3]);
        expect(res.body.entries[0]).toMatchObject({
            candidateId: top,
            finalScore: 5,
            tieBreakApplied: null,
            needsManualReview: false,
        });
        expect(res.body.entries[1]).toMatchObject({
            finalScore: 3,
            tieBreakApplied: "adaptability",
            scores: {
                adaptability: 4,
                fundamentals: 3,
                depth: 3,
                production: 1,
                stack: 3,
            },
        });
        expect(res.body.entries[2].tieBreakApplied).toBe("adaptability");
        expect(res.body.weights).toEqual(WEIGHTS);
    });

    it("desempata por confianza cuando los cinco criterios empatan", async () => {
        await createProcess();
        const low = await createCandidate("Menos Confianza");
        const high = await createCandidate("Más Confianza");
        const equal = {
            adaptability: 3,
            fundamentals: 3,
            depth: 3,
            production: 3,
            stack: 3,
        };

        await score(low, equal, 0.3);
        await score(high, equal, 0.9);

        const res = await request.get("/ranking");
        expect(res.body.entries.map((e: { name: string }) => e.name)).toEqual([
            "Más Confianza",
            "Menos Confianza",
        ]);
        expect(res.body.entries[0].tieBreakApplied).toBe("confidence");
        expect(res.body.entries[0].needsManualReview).toBe(false);
    });

    it("empate total: needsManualReview=true y orden estable de alta", async () => {
        await createProcess();
        const first = await createCandidate("Alta Primero");
        const second = await createCandidate("Alta Segundo");
        const equal = {
            adaptability: 4,
            fundamentals: 4,
            depth: 4,
            production: 4,
            stack: 4,
        };

        await score(first, equal, 0.5);
        await score(second, equal, 0.5);

        const res = await request.get("/ranking");
        expect(res.body.entries.map((e: { name: string }) => e.name)).toEqual([
            "Alta Primero",
            "Alta Segundo",
        ]);
        expect(res.body.entries[0].needsManualReview).toBe(true);
        expect(res.body.entries[1].needsManualReview).toBe(true);
        expect(res.body.entries[0].tieBreakApplied).toBeNull();
    });

    it("candidatos sin score (o con score parcial de notas) van a unscored", async () => {
        await createProcess();
        const scored = await createCandidate("Con Score");
        const pending = await createCandidate("Sin Score");
        const onlyNotes = await createCandidate("Solo Notas");

        await score(scored, {
            adaptability: 3,
            fundamentals: 3,
            depth: 3,
            production: 3,
            stack: 3,
        });
        await request
            .post(`/candidates/${onlyNotes}/notes`)
            .send({ notes: "solo nota" })
            .expect(200);

        const res = await request.get("/ranking");
        expect(res.body.entries).toHaveLength(1);
        expect(res.body.unscored).toEqual(
            expect.arrayContaining([
                {
                    candidateId: pending,
                    name: "Sin Score",
                    analysisStatus: "pending",
                },
                {
                    candidateId: onlyNotes,
                    name: "Solo Notas",
                    analysisStatus: "pending",
                },
            ]),
        );
        expect(res.body.unscored).toHaveLength(2);
    });

    it("candidatos soft-deleted no aparecen ni en entries ni en unscored", async () => {
        await createProcess();
        const kept = await createCandidate("Se Queda");
        const removed = await createCandidate("Borrado");
        await score(kept, {
            adaptability: 3,
            fundamentals: 3,
            depth: 3,
            production: 3,
            stack: 3,
        });
        await score(removed, {
            adaptability: 5,
            fundamentals: 5,
            depth: 5,
            production: 5,
            stack: 5,
        });
        await request.delete(`/candidates/${removed}`).expect(200);

        const res = await request.get("/ranking");
        expect(res.body.entries).toHaveLength(1);
        expect(res.body.entries[0].name).toBe("Se Queda");
        expect(res.body.unscored).toEqual([]);
    });

    it("expone evidencia resumida, dudas pendientes y las 3 primeras preguntas", async () => {
        await createProcess();
        const id = await createCandidate("Analizada");
        await score(id, {
            adaptability: 4,
            fundamentals: 4,
            depth: 3,
            production: 3,
            stack: 2,
        });

        // Como lo habría dejado /analyze: rationale por criterio + doubts.
        db.prepare(
            "UPDATE candidate_score SET evidence_summary = ? WHERE candidate_id = ?",
        ).run(
            JSON.stringify({
                criteria: {
                    adaptability: {
                        rationale: "Transiciones demostradas.",
                        evidence: [],
                    },
                    stack: { rationale: "Sin AWS.", evidence: [] },
                },
                doubts: ["Profundidad real en AWS."],
                risks: [],
            }),
            id,
        );
        const insert = db.prepare(
            `INSERT INTO interview_question (id, candidate_id, criterion, dimension, question)
             VALUES (?, ?, 'adaptability', 'velocidad', ?)`,
        );
        for (let i = 1; i <= 4; i++) {
            insert.run(newId(), id, `Pregunta ${i}`);
        }

        const res = await request.get("/ranking");
        expect(res.status).toBe(200);
        const entry = res.body.entries[0];
        expect(entry.evidenceSummary).toEqual({
            adaptability: "Transiciones demostradas.",
            stack: "Sin AWS.",
        });
        expect(entry.pendingDoubts).toEqual(["Profundidad real en AWS."]);
        expect(entry.keyQuestions).toEqual([
            "Pregunta 1",
            "Pregunta 2",
            "Pregunta 3",
        ]);
    });

    describe("rate limit (§16: 30/hora)", () => {
        it("la llamada 31 en la misma hora responde 429 RATE_LIMITED", async () => {
            await createProcess();
            for (let i = 0; i < RATE_LIMITS_PER_HOUR.RANKING; i++) {
                rateLimiter.check(
                    RANKING_RATE_KEY,
                    RATE_LIMITS_PER_HOUR.RANKING,
                );
            }

            const res = await request.get("/ranking");
            expect(res.status).toBe(429);
            expect(res.body.error.code).toBe("RATE_LIMITED");
        });
    });
});
