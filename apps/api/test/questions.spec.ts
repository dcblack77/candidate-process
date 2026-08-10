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
import {
    GENERATE_QUESTIONS_JSON_SCHEMA,
    generateQuestionsZodSchema,
    MAX_IDEAL_ANSWER_LENGTH,
    MAX_QUESTION_LENGTH,
    MAX_SCORING_GUIDANCE_LENGTH,
    MAX_SIGNAL_LENGTH,
    MAX_SIGNALS,
} from "../src/ai/schemas/generate-questions";

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

    async function createProcess(roleContext?: string): Promise<void> {
        await request
            .post("/process")
            .send({ roleTitle: "Backend Serverless", roleContext })
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
            await createProcess("Equipo de pagos, stack AWS y TypeScript.");
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
                // Sin `validates`: se dejó de pedir al modelo (2026-08-07).
                validates: null,
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

            // El prompt lleva el resumen, el análisis, el contexto del rol y
            // el count.
            const prompt = mock.requests[0].body.messages[0].content;
            expect(prompt).toContain("Backend con transiciones demostradas.");
            expect(prompt).toContain("Validar profundidad.");
            expect(prompt).toContain("Equipo de pagos, stack AWS y TypeScript.");
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

        it("role_context null: se envía un contexto neutro, nunca '{{role_context}}'", async () => {
            await createProcess();
            const id = await createCandidate();
            seedAnalyzed(id);

            await request
                .post(`/candidates/${id}/questions`)
                .send({ count: 2 })
                .expect(201);

            const prompt = mock.requests[0].body.messages[0].content;
            expect(prompt).not.toContain("{{");
            expect(prompt).toContain("(Sin contexto adicional del rol.)");
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

    /**
     * Generar preguntas NO exige análisis previo (decisión del 2026-08-07):
     * exigirlo gastaba una de las 5 regeneraciones de análisis por candidato
     * (§16) solo para poder preguntar.
     */
    describe("sin análisis previo", () => {
        /** Solo CV procesado: lo que deja /cv/extract, sin pasar por /analyze. */
        function seedSummarizedOnly(candidateId: string): void {
            db.prepare(
                `UPDATE candidate
                 SET cv_summary = ?, analysis_status = 'summarized'
                 WHERE id = ?`,
            ).run(
                JSON.stringify({
                    professional_summary: "Backend con transiciones.",
                    evidence: {},
                }),
                candidateId,
            );
        }

        /** El prompt que recibió el modelo en la petición `index`. */
        function promptSent(index = 0): string {
            const request = mock.requests[index];
            expect(request, `no hubo petición ${index} al modelo`).toBeDefined();
            return (request as RecordedRequest).body.messages
                .map((m) => m.content)
                .join("\n");
        }

        it("recorta la segunda pregunta de cola que devuelva el modelo", async () => {
            await createProcess();
            const id = await createCandidate();
            seedSummarizedOnly(id);
            responder = () =>
                chatCompletion({
                    questions: [
                        {
                            ...validQuestions(1).questions[0],
                            question:
                                "¿Cómo migraste a TypeScript? ¿Y qué entregaste después?",
                        },
                    ],
                });

            const res = await request
                .post(`/candidates/${id}/questions`)
                .send({ count: 1 });

            expect(res.status).toBe(201);
            expect(res.body.questions[0].question).toBe(
                "¿Cómo migraste a TypeScript?",
            );
            // Y así queda persistido, no solo en la respuesta.
            expect(questionRows(id)[0].question).toBe(
                "¿Cómo migraste a TypeScript?",
            );
        });

        it("genera preguntas con solo el CV y el contexto del rol", async () => {
            await createProcess();
            const id = await createCandidate();
            seedSummarizedOnly(id);

            const res = await request
                .post(`/candidates/${id}/questions`)
                .send({ count: 4 });

            expect(res.status).toBe(201);
            expect(res.body.questions).toHaveLength(4);
            expect(questionRows(id)).toHaveLength(4);
        });

        it("avisa al modelo de que no hay análisis en vez de mandarle un JSON vacío", async () => {
            await createProcess();
            const id = await createCandidate();
            seedSummarizedOnly(id);

            await request.post(`/candidates/${id}/questions`).send({ count: 2 });

            const prompt = promptSent();
            expect(prompt).toContain("aún no tiene análisis");
            // Un "{}" se leería como "analizado y sin hallazgos".
            expect(prompt).not.toContain('"scores"');
        });

        it("la auditoría distingue si hubo análisis detrás", async () => {
            await createProcess();
            const sinAnalisis = await createCandidate("Sin Analisis");
            seedSummarizedOnly(sinAnalisis);
            await request
                .post(`/candidates/${sinAnalisis}/questions`)
                .send({ count: 1 });

            const conAnalisis = await createCandidate("Con Analisis");
            seedAnalyzed(conAnalisis);
            await request
                .post(`/candidates/${conAnalisis}/questions`)
                .send({ count: 1 });

            const events = eventsByAction(db, "candidate.questions_generated");
            expect(events).toHaveLength(2);
            const flags = events.map(
                (e) => JSON.parse(e.metadata as string).withAnalysis,
            );
            expect(flags).toEqual([false, true]);
        });

        it("si hay análisis, sus dudas siguen llegando al prompt", async () => {
            await createProcess();
            const id = await createCandidate();
            seedAnalyzed(id);

            await request.post(`/candidates/${id}/questions`).send({ count: 2 });

            const prompt = promptSent();
            expect(prompt).toContain("Validar profundidad.");
            expect(prompt).not.toContain("aún no tiene análisis");
        });
    });

    describe("validaciones", () => {
        it("candidato sin CV procesado responde 400 sin llamar al modelo", async () => {
            await createProcess();
            const id = await createCandidate();

            const res = await request
                .post(`/candidates/${id}/questions`)
                .send({});
            expect(res.status).toBe(400);
            expect(res.body.error.code).toBe("INVALID_INPUT");
            expect(mock.requests).toHaveLength(0);
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

/**
 * Contrato de brevedad de las preguntas (decisión del 2026-08-07). El bloque
 * se lee en voz alta durante la entrevista: tiene que entenderse de un vistazo.
 */
describe("contrato del bloque de pregunta", () => {
    /** Una pregunta válida a la que ir rompiendo un campo cada vez. */
    function baseQuestion() {
        return {
            question: "Migraste a microservicios. ¿Cuál fue la decisión más difícil?",
            dimension: "profundidad_vs_exposicion" as const,
            criterion: "depth" as const,
            ideal_answer: "Nombra una decisión concreta y la alternativa que descartó.",
            positive_signals: ["Compara dos alternativas reales."],
            warning_signals: ["Describe la migración sin ninguna decisión."],
            scoring_guidance: "1: sin decisión. 3: sin datos. 5: con validación.",
        };
    }

    it("no pide `validates` al modelo: ni en el JSON Schema ni en zod", () => {
        const props = GENERATE_QUESTIONS_JSON_SCHEMA.properties.questions.items;
        expect(Object.keys(props.properties)).not.toContain("validates");
        expect(props.required).not.toContain("validates");

        // additionalProperties:false + .strict(): si el modelo lo colara igual,
        // la respuesta se rechaza en vez de persistir texto redundante.
        expect(props.additionalProperties).toBe(false);
        const withValidates = {
            questions: [{ ...baseQuestion(), validates: "algo" }],
        };
        expect(generateQuestionsZodSchema.safeParse(withValidates).success).toBe(
            false,
        );
    });

    it("los topes dejan holgura sobre lo que pide el prompt", () => {
        // El prompt pide ~200/~300/~100/~200; el schema va por encima para que
        // una frase larga no dispare un reintento innecesario.
        expect(MAX_QUESTION_LENGTH).toBeGreaterThanOrEqual(200);
        expect(MAX_IDEAL_ANSWER_LENGTH).toBeGreaterThanOrEqual(300);
        expect(MAX_SIGNAL_LENGTH).toBeGreaterThanOrEqual(100);
        expect(MAX_SCORING_GUIDANCE_LENGTH).toBeGreaterThanOrEqual(200);
    });

    it("rechaza los campos que se pasan del tope", () => {
        const cases = [
            { question: "x".repeat(MAX_QUESTION_LENGTH + 1) },
            { ideal_answer: "x".repeat(MAX_IDEAL_ANSWER_LENGTH + 1) },
            { positive_signals: ["x".repeat(MAX_SIGNAL_LENGTH + 1)] },
            { scoring_guidance: "x".repeat(MAX_SCORING_GUIDANCE_LENGTH + 1) },
            // Más señales de las admitidas: el prompt pide 3.
            {
                warning_signals: Array.from(
                    { length: MAX_SIGNALS + 1 },
                    () => "señal",
                ),
            },
        ];
        for (const patch of cases) {
            const result = generateQuestionsZodSchema.safeParse({
                questions: [{ ...baseQuestion(), ...patch }],
            });
            expect(result.success, JSON.stringify(Object.keys(patch))).toBe(
                false,
            );
        }
    });

    it("acepta un bloque breve como el que pide el prompt", () => {
        expect(
            generateQuestionsZodSchema.safeParse({
                questions: [baseQuestion()],
            }).success,
        ).toBe(true);
    });
});
