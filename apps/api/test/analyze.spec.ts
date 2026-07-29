import { Server } from "node:http";
import { createModule, interfaces } from "@expressots/core";
import supertest from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { CRITERIA } from "../src/ai/schemas/common";
import { App } from "../src/app";
import { Database, DB } from "../src/db/database";
import { AppEnv, ENV, loadEnv } from "../src/env";
import { ANALYZE_RATE_KEY } from "../src/scoring/analyze-candidate.usecase";
import { RateLimiter } from "../src/security/rate-limit";
import { AuditRepository } from "../src/shared/audit";
import { newId } from "../src/shared/ids";
import {
    MAX_ANALYSIS_REGENERATIONS,
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
 * Integración de POST /candidates/:id/analyze sobre la app real: supertest +
 * DB :memory: + mock HTTP de llama.cpp. Los tests NUNCA hablan con el modelo
 * real.
 */

/** cv_summary sembrado directamente (como lo habría dejado /cv/extract). */
function seededSummary() {
    return {
        professional_summary: "Backend con transiciones demostradas.",
        evidence: {
            adaptability: [
                { text: "Migró de Java a Node.js.", type: "explicit" },
            ],
            fundamentals: [],
            depth: [],
            production: [],
            stack: [],
        },
        technology_transitions: ["Java a Node.js"],
        doubts_for_interview: [],
        risks: [],
    };
}

/**
 * Respuesta válida del modelo para score-candidate. Los scores (5,4,3,2,1)
 * NO "cuadran" con ninguna aritmética del modelo: el rationale incluso
 * afirma un score final absurdo. El backend debe ignorarlo y calcular
 * 5*0.30 + 4*0.25 + 3*0.20 + 2*0.15 + 1*0.10 = 3.5.
 */
function validAnalysis(verdict?: string) {
    const criterion = (score: number, rationale: string) => ({
        score,
        rationale,
        evidence: [
            { text: "Evidencia explícita del resumen.", type: "explicit" },
        ],
        // Sin verdict explícito se omite el campo: así este helper sigue
        // representando una salida ANTIGUA del modelo (compatibilidad).
        ...(verdict === undefined ? {} : { verdict }),
    });
    return {
        scores: {
            adaptability: criterion(
                5,
                "Transiciones reales. El score final es 1.23.",
            ),
            fundamentals: criterion(4, "Base transferible."),
            depth: criterion(3, "Resultados parciales."),
            production: criterion(2, "Poca operación real."),
            stack: criterion(1, "Sin AWS ni TypeScript."),
        },
        confidence: 0.7,
        doubts: ["Validar profundidad real en entrevista."],
        risks: ["Poca experiencia operando en producción."],
    };
}

const EXPECTED_FINAL_SCORE = 3.5;

type Responder = (
    request: RecordedRequest,
    index: number,
) => { status: number; body?: unknown };

describe("POST /candidates/:id/analyze", () => {
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
        responder = () => chatCompletion(validAnalysis());
    });

    async function createProcess(): Promise<string> {
        const res = await request
            .post("/process")
            .send({
                roleTitle: "Backend Serverless",
                roleContext: "Stack AWS.",
            });
        expect(res.status).toBe(201);
        return res.body.id as string;
    }

    async function createCandidate(name = "Ana Ejemplo"): Promise<string> {
        const res = await request.post("/candidates").send({ name });
        expect(res.status).toBe(201);
        return res.body.id as string;
    }

    /** Deja al candidato como lo dejaría /cv/extract (resumen persistido). */
    function seedSummary(candidateId: string): void {
        const summary = seededSummary();
        db.prepare(
            `UPDATE candidate
             SET cv_summary = ?, cv_evidence = ?, analysis_status = 'summarized'
             WHERE id = ?`,
        ).run(
            JSON.stringify(summary),
            JSON.stringify(summary.evidence),
            candidateId,
        );
    }

    function scoreRow(
        candidateId: string,
    ): Record<string, unknown> | undefined {
        return db
            .prepare("SELECT * FROM candidate_score WHERE candidate_id = ?")
            .get(candidateId) as Record<string, unknown> | undefined;
    }

    function candidateStatus(candidateId: string): string {
        const row = db
            .prepare("SELECT analysis_status FROM candidate WHERE id = ?")
            .get(candidateId) as { analysis_status: string };
        return row.analysis_status;
    }

    describe("camino feliz", () => {
        it("200: el backend recalcula finalScore con weights.ts, ignora la aritmética del modelo y persiste todo", async () => {
            await createProcess();
            const id = await createCandidate();
            seedSummary(id);

            const res = await request.post(`/candidates/${id}/analyze`);

            expect(res.status).toBe(200);
            expect(res.body).toMatchObject({
                candidateId: id,
                analysisStatus: "analyzed",
                finalScore: EXPECTED_FINAL_SCORE,
                confidence: 0.7,
                doubts: ["Validar profundidad real en entrevista."],
                risks: ["Poca experiencia operando en producción."],
                regenerationsUsed: 1,
                regenerationsLimit: MAX_ANALYSIS_REGENERATIONS,
            });
            expect(res.body.suggestedScores.adaptability).toMatchObject({
                score: 5,
                evidence: [
                    {
                        text: "Evidencia explícita del resumen.",
                        type: "explicit",
                    },
                ],
            });

            // Persistencia: scores sugeridos + finalScore recalculado.
            const row = scoreRow(id);
            expect(row).toMatchObject({
                adaptability: 5,
                fundamentals: 4,
                depth: 3,
                production: 2,
                stack: 1,
                final_score: EXPECTED_FINAL_SCORE,
                confidence: 0.7,
            });
            const evidenceSummary = JSON.parse(
                (row as Record<string, unknown>).evidence_summary as string,
            );
            expect(evidenceSummary.doubts).toEqual([
                "Validar profundidad real en entrevista.",
            ]);
            expect(evidenceSummary.risks).toEqual([
                "Poca experiencia operando en producción.",
            ]);
            expect(evidenceSummary.criteria.adaptability.rationale).toContain(
                "Transiciones reales",
            );
            expect(candidateStatus(id)).toBe("analyzed");

            // El prompt lleva el resumen y el rol, nunca placeholders sueltos.
            const prompt = mock.requests[0].body.messages[0].content;
            expect(prompt).toContain("Backend con transiciones demostradas.");
            expect(prompt).toContain("Backend Serverless");
            expect(prompt).not.toContain("{{");

            // Auditoría: un evento candidate.analyzed sin contenido.
            const events = eventsByAction(db, "candidate.analyzed");
            expect(events).toHaveLength(1);
            expect(events[0].entity_id).toBe(id);
            const metadata = JSON.parse(events[0].metadata as string);
            expect(metadata.regeneration).toBe(1);
            expect(JSON.stringify(metadata)).not.toContain("Transiciones");
        });

        it("GET /candidates/:id incluye el score tras el análisis", async () => {
            await createProcess();
            const id = await createCandidate();
            seedSummary(id);
            await request.post(`/candidates/${id}/analyze`).expect(200);

            const res = await request.get(`/candidates/${id}`);
            expect(res.status).toBe(200);
            expect(res.body.score).toMatchObject({
                candidateId: id,
                scores: {
                    adaptability: 5,
                    fundamentals: 4,
                    depth: 3,
                    production: 2,
                    stack: 1,
                },
                finalScore: EXPECTED_FINAL_SCORE,
                confidence: 0.7,
            });
            expect(res.body.score.evidenceSummary.doubts).toEqual([
                "Validar profundidad real en entrevista.",
            ]);
            expect(res.body.questions).toEqual([]);
        });

        it("re-analizar upsertea la fila y conserva manual_notes", async () => {
            await createProcess();
            const id = await createCandidate();
            seedSummary(id);

            await request
                .post(`/candidates/${id}/notes`)
                .send({ notes: "Nota privada previa" })
                .expect(200);

            const first = await request.post(`/candidates/${id}/analyze`);
            expect(first.status).toBe(200);
            const second = await request.post(`/candidates/${id}/analyze`);
            expect(second.status).toBe(200);
            expect(second.body.regenerationsUsed).toBe(2);

            const rows = db
                .prepare(
                    "SELECT COUNT(*) AS total FROM candidate_score WHERE candidate_id = ?",
                )
                .get(id) as { total: number };
            expect(rows.total).toBe(1);
            expect(scoreRow(id)).toMatchObject({
                manual_notes: "Nota privada previa",
            });
        });
    });

    describe("contraste con la entrevista (§13)", () => {
        /** Pregunta persistida con su respuesta puntuada. */
        function seedAnsweredQuestion(
            candidateId: string,
            criterion: string,
            answerScore: number,
            notes: string,
        ): void {
            db.prepare(
                `INSERT INTO interview_question
                     (id, candidate_id, criterion, dimension, question, ideal_answer,
                      answer_score, answer_notes, answered_at)
                 VALUES (?, ?, ?, 'velocidad', ?, ?, ?, ?, '2026-07-29T00:00:00.000Z')`,
            ).run(
                newId(),
                candidateId,
                criterion,
                `PREGUNTA-${criterion.toUpperCase()}: cuéntame una transición.`,
                `RESPUESTA-IDEAL-${criterion.toUpperCase()}`,
                answerScore,
                `NOTAS-EVALUADOR-${criterion.toUpperCase()}`,
            );
        }

        it("con respuestas puntuadas el prompt lleva el contexto de entrevista", async () => {
            await createProcess();
            const id = await createCandidate();
            seedSummary(id);
            seedAnsweredQuestion(id, "adaptability", 3, "flojo");
            seedAnsweredQuestion(id, "stack", 9, "sólido");

            responder = () => chatCompletion(validAnalysis("not_demonstrated"));
            await request.post(`/candidates/${id}/analyze`).expect(200);

            const prompt = mock.requests[0].body.messages[0].content;
            // Criterio, enunciado, respuesta ideal, nota y notas del evaluador.
            expect(prompt).toContain("Respuestas puntuadas: 2 de 2 preguntas");
            expect(prompt).toContain("Adaptabilidad (`adaptability`)");
            expect(prompt).toContain(
                "PREGUNTA-ADAPTABILITY: cuéntame una transición.",
            );
            expect(prompt).toContain("RESPUESTA-IDEAL-ADAPTABILITY");
            expect(prompt).toContain("Nota del evaluador: 3/10");
            expect(prompt).toContain("NOTAS-EVALUADOR-ADAPTABILITY");
            expect(prompt).toContain("Nota del evaluador: 9/10");
            expect(prompt).not.toContain(
                "Sin respuestas de entrevista puntuadas",
            );
            expect(prompt).not.toContain("{{");
        });

        it("las preguntas SIN nota no viajan al prompt (no son evidencia)", async () => {
            await createProcess();
            const id = await createCandidate();
            seedSummary(id);
            db.prepare(
                `INSERT INTO interview_question (id, candidate_id, criterion, dimension, question)
                 VALUES (?, ?, 'depth', 'velocidad', 'PREGUNTA-SIN-NOTA')`,
            ).run(newId(), id);

            await request.post(`/candidates/${id}/analyze`).expect(200);

            const prompt = mock.requests[0].body.messages[0].content;
            expect(prompt).not.toContain("PREGUNTA-SIN-NOTA");
            expect(prompt).toContain("Sin respuestas de entrevista puntuadas");
        });

        it("sin respuestas puntuadas el prompt NO lleva contexto y los verdict quedan en not_assessed", async () => {
            await createProcess();
            const id = await createCandidate();
            seedSummary(id);

            // Aunque el modelo se invente un veredicto, sin entrevista no hay
            // contraste posible: el backend lo normaliza a not_assessed.
            responder = () => chatCompletion(validAnalysis("confirmed"));
            const res = await request.post(`/candidates/${id}/analyze`);

            expect(res.status).toBe(200);
            const prompt = mock.requests[0].body.messages[0].content;
            expect(prompt).toContain("Sin respuestas de entrevista puntuadas");
            expect(prompt).not.toContain("Nota del evaluador");

            for (const criterion of CRITERIA) {
                expect(res.body.suggestedScores[criterion].verdict).toBe(
                    "not_assessed",
                );
            }
            const summary = JSON.parse(
                scoreRow(id)?.evidence_summary as string,
            );
            expect(summary.criteria.adaptability.verdict).toBe("not_assessed");
        });

        it("con entrevista, los verdict del modelo se persisten y se devuelven", async () => {
            await createProcess();
            const id = await createCandidate();
            seedSummary(id);
            seedAnsweredQuestion(id, "adaptability", 3, "flojo");

            responder = () => chatCompletion(validAnalysis("not_demonstrated"));
            const res = await request.post(`/candidates/${id}/analyze`);

            expect(res.status).toBe(200);
            expect(res.body.suggestedScores.adaptability.verdict).toBe(
                "not_demonstrated",
            );
            const summary = JSON.parse(
                scoreRow(id)?.evidence_summary as string,
            );
            expect(summary.criteria.stack.verdict).toBe("not_demonstrated");

            // GET /candidates/:id expone los veredictos ya tipados.
            const detail = await request.get(`/candidates/${id}`);
            expect(detail.body.score.verdicts).toEqual({
                adaptability: "not_demonstrated",
                fundamentals: "not_demonstrated",
                depth: "not_demonstrated",
                production: "not_demonstrated",
                stack: "not_demonstrated",
            });
        });

        it("compatibilidad: una salida SIN verdict sigue siendo válida (not_assessed)", async () => {
            await createProcess();
            const id = await createCandidate();
            seedSummary(id);
            seedAnsweredQuestion(id, "adaptability", 8, "bien");

            // validAnalysis() sin argumento no emite el campo `verdict`.
            const res = await request.post(`/candidates/${id}/analyze`);

            expect(res.status).toBe(200);
            expect(res.body.suggestedScores.adaptability.verdict).toBe(
                "not_assessed",
            );
        });

        it("la respuesta trae el score combinado 30/70 y provisional", async () => {
            await createProcess();
            const id = await createCandidate();
            seedSummary(id);

            const withoutInterview = await request.post(
                `/candidates/${id}/analyze`,
            );
            expect(withoutInterview.status).toBe(200);
            expect(withoutInterview.body).toMatchObject({
                cvScore: EXPECTED_FINAL_SCORE,
                finalScore: EXPECTED_FINAL_SCORE,
                interviewScore: null,
                overallScore: EXPECTED_FINAL_SCORE,
                provisional: true,
            });

            // Con entrevista de 8: 3.5*0.30 + 4.0*0.70 = 1.05 + 2.80 = 3.85.
            seedAnsweredQuestion(id, "adaptability", 8, "bien");
            const withInterview = await request.post(
                `/candidates/${id}/analyze`,
            );
            expect(withInterview.body).toMatchObject({
                cvScore: EXPECTED_FINAL_SCORE,
                interviewScore: 8,
                overallScore: 3.85,
                provisional: false,
            });
        });

        it("las notas del evaluador NO se filtran a la auditoría (§17)", async () => {
            await createProcess();
            const id = await createCandidate();
            seedSummary(id);
            seedAnsweredQuestion(id, "adaptability", 3, "flojo");

            await request.post(`/candidates/${id}/analyze`).expect(200);

            const events = eventsByAction(db, "candidate.analyzed");
            const metadata = events[0].metadata as string;
            expect(metadata).not.toContain("NOTAS-EVALUADOR");
            expect(JSON.parse(metadata).interviewAnswers).toBe(1);
        });
    });

    describe("límite de regeneraciones (§16: 5 por candidato)", () => {
        it("la 6ª regeneración responde 422 LIMIT_EXCEEDED sin llamar al modelo", async () => {
            await createProcess();
            const id = await createCandidate();
            seedSummary(id);

            for (let i = 0; i < MAX_ANALYSIS_REGENERATIONS; i++) {
                const res = await request.post(`/candidates/${id}/analyze`);
                expect(res.status).toBe(200);
                expect(res.body.regenerationsUsed).toBe(i + 1);
            }
            expect(mock.requests).toHaveLength(MAX_ANALYSIS_REGENERATIONS);

            const sixth = await request.post(`/candidates/${id}/analyze`);
            expect(sixth.status).toBe(422);
            expect(sixth.body.error.code).toBe("LIMIT_EXCEEDED");
            expect(mock.requests).toHaveLength(MAX_ANALYSIS_REGENERATIONS);
        });

        it("el límite es por candidato: otro candidato empieza de cero", async () => {
            await createProcess();
            const first = await createCandidate("Primero");
            const second = await createCandidate("Segundo");
            seedSummary(first);
            seedSummary(second);

            for (let i = 0; i < MAX_ANALYSIS_REGENERATIONS; i++) {
                await request.post(`/candidates/${first}/analyze`).expect(200);
            }
            await request.post(`/candidates/${first}/analyze`).expect(422);

            const res = await request.post(`/candidates/${second}/analyze`);
            expect(res.status).toBe(200);
            expect(res.body.regenerationsUsed).toBe(1);
        });
    });

    describe("validaciones", () => {
        it("sin cv_summary responde 400 INVALID_INPUT (decisión documentada: no hay 409 apropiado) y no llama al modelo", async () => {
            await createProcess();
            const id = await createCandidate();

            const res = await request.post(`/candidates/${id}/analyze`);
            expect(res.status).toBe(400);
            expect(res.body.error.code).toBe("INVALID_INPUT");
            expect(mock.requests).toHaveLength(0);
            expect(candidateStatus(id)).toBe("pending");
        });

        it("candidato inexistente responde 404", async () => {
            await createProcess();
            const res = await request.post(`/candidates/${newId()}/analyze`);
            expect(res.status).toBe(404);
            expect(res.body.error.code).toBe("NOT_FOUND");
        });

        it("sin proceso activo responde 404", async () => {
            const res = await request.post(`/candidates/${newId()}/analyze`);
            expect(res.status).toBe(404);
        });

        it("id que no es UUID responde 400", async () => {
            await createProcess();
            const res = await request.post("/candidates/no-es-uuid/analyze");
            expect(res.status).toBe(400);
        });
    });

    describe("modelo caído o inválido", () => {
        it("500 del modelo → 502, analysis_status='failed' y el reintento recupera", async () => {
            await createProcess();
            const id = await createCandidate();
            seedSummary(id);

            responder = () => ({ status: 500 });
            const res = await request.post(`/candidates/${id}/analyze`);
            expect(res.status).toBe(502);
            expect(res.body.error.code).toBe("LLM_UNAVAILABLE");
            expect(candidateStatus(id)).toBe("failed");
            // El fallo NO consume regeneraciones (no hay evento).
            expect(eventsByAction(db, "candidate.analyzed")).toHaveLength(0);

            responder = () => chatCompletion(validAnalysis());
            const retry = await request.post(`/candidates/${id}/analyze`);
            expect(retry.status).toBe(200);
            expect(retry.body.regenerationsUsed).toBe(1);
            expect(candidateStatus(id)).toBe("analyzed");
        });

        it("el modelo intenta colar final_score → el schema estricto lo rechaza y responde 502", async () => {
            await createProcess();
            const id = await createCandidate();
            seedSummary(id);

            responder = () =>
                chatCompletion({ ...validAnalysis(), final_score: 4.99 });
            const res = await request.post(`/candidates/${id}/analyze`);
            expect(res.status).toBe(502);
            expect(candidateStatus(id)).toBe("failed");
            expect(scoreRow(id)).toBeUndefined();
        });
    });

    describe("rate limit (§16: 30/hora)", () => {
        it("la llamada 31 en la misma hora responde 429 RATE_LIMITED", async () => {
            await createProcess();
            const id = await createCandidate();
            seedSummary(id);

            for (let i = 0; i < RATE_LIMITS_PER_HOUR.ANALYZE; i++) {
                rateLimiter.check(
                    ANALYZE_RATE_KEY,
                    RATE_LIMITS_PER_HOUR.ANALYZE,
                );
            }

            const res = await request.post(`/candidates/${id}/analyze`);
            expect(res.status).toBe(429);
            expect(res.body.error.code).toBe("RATE_LIMITED");
            expect(mock.requests).toHaveLength(0);
            // El rechazo por rate limit no deja al candidato en 'analyzing'.
            expect(candidateStatus(id)).toBe("summarized");
        });
    });
});
