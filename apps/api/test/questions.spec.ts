import { Server } from "node:http";
import { createModule, interfaces } from "@expressots/core";
import supertest from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { App } from "../src/app";
import { Database, DB } from "../src/db/database";
import { AppEnv, ENV, loadEnv } from "../src/env";
import { QUESTIONS_RATE_KEY } from "../src/questions/generate-questions.usecase";
import { RateLimiter } from "../src/security/rate-limit";
import { AuditRepository } from "../src/shared/audit";
import { newId } from "../src/shared/ids";
import {
    MAX_QUESTIONS_PER_CANDIDATE,
    RATE_LIMITS_PER_HOUR,
} from "../src/shared/limits";
import { eventsByAction, resetDb } from "./app-helpers";
import {
    chatCompletion,
    MockLlm,
    RecordedRequest,
    startMockLlm,
} from "./ai-helpers";
import { createTestDb } from "./helpers";

/**
 * Integración de POST /candidates/:id/questions sobre la app real: supertest
 * + DB :memory: + mock HTTP de llama.cpp.
 */

const DIMENSIONS = [
    "velocidad",
    "profundidad_vs_exposicion",
    "contribucion",
    "aprendizaje",
    "investigacion",
    "operacion",
] as const;
const CRITERIA = [
    "adaptability",
    "fundamentals",
    "depth",
    "production",
    "stack",
] as const;

/** `count` preguntas válidas según el schema de generate-questions. */
function validQuestions(count: number) {
    return {
        questions: Array.from({ length: count }, (_, i) => ({
            question: `Pregunta personalizada número ${i + 1} sobre su transición real.`,
            dimension: DIMENSIONS[i % DIMENSIONS.length],
            criterion: CRITERIA[i % CRITERIA.length],
            validates: "Si la transición fue real y con contribución.",
            ideal_answer: "Describe contexto, brechas, método y entregables.",
            positive_signals: ["Da fechas concretas", "Explica trade-offs"],
            warning_signals: ["Responde con generalidades"],
            scoring_guidance:
                "1 sin evidencia; 3 adaptación parcial; 5 transición demostrada.",
        })),
    };
}

type Responder = (
    request: RecordedRequest,
    index: number,
) => { status: number; body?: unknown };

describe("POST /candidates/:id/questions", () => {
    let db: Database;
    let request: ReturnType<typeof supertest>;
    let server: Server;
    let mock: MockLlm;
    const rateLimiter = new RateLimiter();
    let responder: Responder;

    beforeAll(async () => {
        mock = await startMockLlm((req, index) => responder(req, index));
        db = createTestDb();
        const env: AppEnv = {
            ...loadEnv(),
            LLM_BASE_URL: mock.url,
            LLM_MAX_RETRIES: 0,
        };

        const TestCoreModule = createModule((bind: interfaces.Bind) => {
            bind<AppEnv>(ENV).toConstantValue(env);
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
        await mock.close();
    });

    beforeEach(() => {
        resetDb(db);
        rateLimiter.reset();
        mock.requests.length = 0;
        responder = (req) => {
            // El mock devuelve exactamente las preguntas pedidas en el prompt.
            const match = /exactamente \*\*(\d+)\*\*/.exec(
                req.body.messages[0].content,
            );
            return chatCompletion(validQuestions(match ? Number(match[1]) : 8));
        };
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

    /** Deja al candidato como lo dejaría /analyze: resumen + score + estado. */
    function seedAnalyzed(candidateId: string): void {
        const summary = {
            professional_summary: "Backend con transiciones demostradas.",
            evidence: {},
        };
        db.prepare(
            `UPDATE candidate
             SET cv_summary = ?, cv_evidence = '{}', analysis_status = 'analyzed'
             WHERE id = ?`,
        ).run(JSON.stringify(summary), candidateId);
        db.prepare(
            `INSERT INTO candidate_score
                 (id, candidate_id, adaptability, fundamentals, depth, production, stack,
                  final_score, confidence, evidence_summary)
             VALUES (?, ?, 5, 4, 3, 2, 1, 3.5, 0.7, ?)`,
        ).run(
            newId(),
            candidateId,
            JSON.stringify({
                criteria: {
                    adaptability: {
                        rationale: "Transiciones reales.",
                        evidence: [],
                    },
                },
                doubts: ["Validar profundidad."],
                risks: ["Poca producción."],
            }),
        );
    }

    function questionRows(candidateId: string): Array<Record<string, unknown>> {
        return db
            .prepare(
                "SELECT * FROM interview_question WHERE candidate_id = ? ORDER BY rowid",
            )
            .all(candidateId) as Array<Record<string, unknown>>;
    }

    describe("camino feliz", () => {
        it("201 con count por defecto 8: persiste con señales JSON y responde el bloque completo", async () => {
            await createProcess();
            const id = await createCandidate();
            seedAnalyzed(id);

            const res = await request
                .post(`/candidates/${id}/questions`)
                .send({});

            expect(res.status).toBe(201);
            expect(res.body).toMatchObject({
                candidateId: id,
                questionsTotal: 8,
                questionsLimit: MAX_QUESTIONS_PER_CANDIDATE,
            });
            expect(res.body.questions).toHaveLength(8);
            expect(res.body.questions[0]).toMatchObject({
                question:
                    "Pregunta personalizada número 1 sobre su transición real.",
                dimension: "velocidad",
                criterion: "adaptability",
                validates: "Si la transición fue real y con contribución.",
                idealAnswer:
                    "Describe contexto, brechas, método y entregables.",
                positiveSignals: ["Da fechas concretas", "Explica trade-offs"],
                warningSignals: ["Responde con generalidades"],
                scoringGuidance:
                    "1 sin evidencia; 3 adaptación parcial; 5 transición demostrada.",
            });

            // Persistencia: 8 filas con señales serializadas como JSON.
            const rows = questionRows(id);
            expect(rows).toHaveLength(8);
            expect(JSON.parse(rows[0].positive_signals as string)).toEqual([
                "Da fechas concretas",
                "Explica trade-offs",
            ]);
            expect(JSON.parse(rows[0].warning_signals as string)).toEqual([
                "Responde con generalidades",
            ]);

            // El prompt lleva el resumen, el análisis y el count.
            const prompt = mock.requests[0].body.messages[0].content;
            expect(prompt).toContain("Backend con transiciones demostradas.");
            expect(prompt).toContain("Validar profundidad.");
            expect(prompt).toContain("exactamente **8**");
            expect(prompt).not.toContain("{{");

            // Auditoría sin contenido.
            const events = eventsByAction(db, "candidate.questions_generated");
            expect(events).toHaveLength(1);
            const metadata = JSON.parse(events[0].metadata as string);
            expect(metadata).toMatchObject({
                requested: 8,
                created: 8,
                total: 8,
            });
        });

        it("count personalizado (3) y acumulación en llamadas sucesivas", async () => {
            await createProcess();
            const id = await createCandidate();
            seedAnalyzed(id);

            const first = await request
                .post(`/candidates/${id}/questions`)
                .send({ count: 3 });
            expect(first.status).toBe(201);
            expect(first.body.questions).toHaveLength(3);
            expect(first.body.questionsTotal).toBe(3);

            const second = await request
                .post(`/candidates/${id}/questions`)
                .send({ count: 5 });
            expect(second.status).toBe(201);
            expect(second.body.questionsTotal).toBe(8);
            expect(questionRows(id)).toHaveLength(8);
        });

        it("GET /candidates/:id incluye las preguntas persistidas", async () => {
            await createProcess();
            const id = await createCandidate();
            seedAnalyzed(id);
            await request
                .post(`/candidates/${id}/questions`)
                .send({ count: 2 })
                .expect(201);

            const res = await request.get(`/candidates/${id}`);
            expect(res.status).toBe(200);
            expect(res.body.questions).toHaveLength(2);
            expect(res.body.questions[0]).toMatchObject({
                dimension: "velocidad",
                positiveSignals: ["Da fechas concretas", "Explica trade-offs"],
            });
            expect(res.body.score.finalScore).toBe(3.5);
        });
    });

    describe("límite (§16: 20 preguntas por candidato)", () => {
        it("existentes + count > 20 responde 422 LIMIT_EXCEEDED sin llamar al modelo", async () => {
            await createProcess();
            const id = await createCandidate();
            seedAnalyzed(id);

            await request
                .post(`/candidates/${id}/questions`)
                .send({ count: 15 })
                .expect(201);
            mock.requests.length = 0;

            const res = await request
                .post(`/candidates/${id}/questions`)
                .send({ count: 6 });
            expect(res.status).toBe(422);
            expect(res.body.error.code).toBe("LIMIT_EXCEEDED");
            expect(mock.requests).toHaveLength(0);
            expect(questionRows(id)).toHaveLength(15);
        });

        it("el borde exacto (15 + 5 = 20) sí se permite; la siguiente ya no", async () => {
            await createProcess();
            const id = await createCandidate();
            seedAnalyzed(id);

            await request
                .post(`/candidates/${id}/questions`)
                .send({ count: 15 })
                .expect(201);
            const exact = await request
                .post(`/candidates/${id}/questions`)
                .send({ count: 5 });
            expect(exact.status).toBe(201);
            expect(exact.body.questionsTotal).toBe(MAX_QUESTIONS_PER_CANDIDATE);

            const overflow = await request
                .post(`/candidates/${id}/questions`)
                .send({ count: 1 });
            expect(overflow.status).toBe(422);
        });
    });

    describe("validaciones", () => {
        it("candidato sin analizar responde 400 INVALID_INPUT sin llamar al modelo", async () => {
            await createProcess();
            const id = await createCandidate();

            const res = await request
                .post(`/candidates/${id}/questions`)
                .send({});
            expect(res.status).toBe(400);
            expect(res.body.error.code).toBe("INVALID_INPUT");
            expect(mock.requests).toHaveLength(0);
        });

        it("candidato con resumen pero sin análisis también responde 400", async () => {
            await createProcess();
            const id = await createCandidate();
            db.prepare(
                "UPDATE candidate SET cv_summary = '{}', analysis_status = 'summarized' WHERE id = ?",
            ).run(id);

            const res = await request
                .post(`/candidates/${id}/questions`)
                .send({});
            expect(res.status).toBe(400);
        });

        it.each([[0], [21], [2.5], ["ocho"]])(
            "count inválido (%s) responde 400",
            async (count) => {
                await createProcess();
                const id = await createCandidate();
                seedAnalyzed(id);

                const res = await request
                    .post(`/candidates/${id}/questions`)
                    .send({ count });
                expect(res.status).toBe(400);
                expect(res.body.error.code).toBe("INVALID_INPUT");
            },
        );

        it("candidato inexistente 404; sin proceso activo 404", async () => {
            await createProcess();
            const missing = await request
                .post(`/candidates/${newId()}/questions`)
                .send({});
            expect(missing.status).toBe(404);

            resetDb(db);
            const noProcess = await request
                .post(`/candidates/${newId()}/questions`)
                .send({});
            expect(noProcess.status).toBe(404);
        });
    });

    describe("modelo caído", () => {
        it("502 y no persiste ninguna pregunta", async () => {
            await createProcess();
            const id = await createCandidate();
            seedAnalyzed(id);

            responder = () => ({ status: 500 });
            const res = await request
                .post(`/candidates/${id}/questions`)
                .send({});
            expect(res.status).toBe(502);
            expect(res.body.error.code).toBe("LLM_UNAVAILABLE");
            expect(questionRows(id)).toHaveLength(0);
        });
    });

    describe("rate limit (§16: 60/hora)", () => {
        it("la llamada 61 en la misma hora responde 429 RATE_LIMITED", async () => {
            await createProcess();
            const id = await createCandidate();
            seedAnalyzed(id);

            for (let i = 0; i < RATE_LIMITS_PER_HOUR.QUESTIONS; i++) {
                rateLimiter.check(
                    QUESTIONS_RATE_KEY,
                    RATE_LIMITS_PER_HOUR.QUESTIONS,
                );
            }

            const res = await request
                .post(`/candidates/${id}/questions`)
                .send({});
            expect(res.status).toBe(429);
            expect(res.body.error.code).toBe("RATE_LIMITED");
            expect(mock.requests).toHaveLength(0);
        });
    });
});
