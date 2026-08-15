import { mkdtempSync, rmSync } from "node:fs";
import { Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { createModule, interfaces } from "@expressots/core";
import supertest from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { CRITERIA } from "../src/ai/schemas/common";
import { App } from "../src/app";
import {
    COMPARE_RATE_KEY,
    COMPARED_ACTION,
    COMPARISON_DISCLAIMER,
} from "../src/comparison/compare-candidates.usecase";
import { Database, DB } from "../src/db/database";
import { AppEnv, ENV, loadEnv } from "../src/env";
import { WEIGHTS } from "../src/scoring/weights";
import { RateLimiter } from "../src/security/rate-limit";
import { AuditRepository } from "../src/shared/audit";
import { newId } from "../src/shared/ids";
import {
    MAX_COMPARISON_CANDIDATES,
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
 * Integración de POST /comparison: supertest + DB :memory: + mock HTTP de
 * llama.cpp, con el prompt REAL del repo (prompts/compare-candidates.md).
 *
 * Usa la App real con ComparisonModule registrado y sustituye únicamente el
 * módulo transversal para trabajar con SQLite :memory: y el mock local.
 */

type Responder = (
    request: RecordedRequest,
    index: number,
) => { status: number; body?: unknown };

/** Salida válida del modelo para las referencias dadas. */
function validComparison(refs: string[]) {
    return {
        criteria: Object.fromEntries(
            CRITERIA.map((criterion, i) => [
                criterion,
                {
                    leaders: [refs[i % refs.length]],
                    analysis: `Análisis de ${criterion}.`,
                },
            ]),
        ),
        evidence_quality:
            "C1 se apoya en evidencias explícitas; C2 en inferencias.",
        profiles: "Perfiles complementarios: producción vs adaptabilidad.",
        ties: [
            {
                candidates: [refs[0], refs[1]],
                what_would_separate: "Una entrevista sobre profundidad.",
            },
        ],
        open_questions: ["¿Cuánto código produjo en producción?"],
        summary: "Diferencias pequeñas; la entrevista decidirá.",
    };
}

describe("POST /comparison", () => {
    let db: Database;
    let request: ReturnType<typeof supertest>;
    let server: Server;
    let mock: MockLlm;
    let recordingsDir: string;
    const rateLimiter = new RateLimiter();
    let responder: Responder;

    beforeAll(async () => {
        mock = await startMockLlm((req, index) => responder(req, index));
        db = createTestDb();
        recordingsDir = mkdtempSync(
            path.join(os.tmpdir(), "comparison-recordings-"),
        );
        const env: AppEnv = {
            ...loadEnv(),
            LLM_BASE_URL: mock.url,
            LLM_MAX_RETRIES: 0,
            RECORDINGS_DIR: recordingsDir,
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
        rmSync(recordingsDir, { recursive: true, force: true });
    });

    beforeEach(() => {
        resetDb(db);
        rateLimiter.reset();
        mock.requests.length = 0;
        responder = (req) => {
            // Las referencias válidas son el enum del schema de la petición.
            const schema = req.body.response_format.json_schema.schema as {
                properties: {
                    criteria: {
                        properties: {
                            depth: {
                                properties: { leaders: { items: { enum: string[] } } };
                            };
                        };
                    };
                };
            };
            const refs =
                schema.properties.criteria.properties.depth.properties.leaders
                    .items.enum;
            return chatCompletion(validComparison(refs));
        };
    });

    async function createProcess(): Promise<string> {
        const res = await request
            .post("/process")
            .send({ roleTitle: "Backend Serverless" });
        expect(res.status).toBe(201);
        return res.body.id as string;
    }

    async function createCandidate(name: string): Promise<string> {
        const res = await request.post("/candidates").send({ name });
        expect(res.status).toBe(201);
        return res.body.id as string;
    }

    /** Deja al candidato como lo dejaría /analyze: resumen + score completo. */
    function seedAnalyzed(
        candidateId: string,
        scores: [number, number, number, number, number] = [4, 3, 3, 2, 4],
    ): void {
        db.prepare(
            `UPDATE candidate
             SET cv_summary = ?, cv_evidence = '{}', analysis_status = 'analyzed'
             WHERE id = ?`,
        ).run(
            JSON.stringify({
                professional_summary: `Resumen profesional de ${candidateId}.`,
                evidence: {},
                technology_transitions: ["Java → TypeScript"],
                doubts_for_interview: [],
                risks: [],
            }),
            candidateId,
        );
        const finalScore =
            scores[0] * 0.3 +
            scores[1] * 0.25 +
            scores[2] * 0.2 +
            scores[3] * 0.15 +
            scores[4] * 0.1;
        db.prepare(
            `INSERT INTO candidate_score
                 (id, candidate_id, adaptability, fundamentals, depth, production, stack,
                  final_score, confidence, evidence_summary, manual_notes)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0.7, ?, ?)`,
        ).run(
            newId(),
            candidateId,
            ...scores,
            Math.round(finalScore * 100) / 100,
            JSON.stringify({
                criteria: {
                    adaptability: {
                        rationale: `Rationale adaptabilidad ${candidateId}.`,
                        evidence: [
                            {
                                text: `Evidencia explícita ${candidateId}.`,
                                type: "explicit",
                            },
                        ],
                        verdict: "confirmed",
                    },
                },
                doubts: [`Duda pendiente ${candidateId}.`],
                risks: ["Riesgo."],
            }),
            `NOTA PRIVADA ${candidateId}`,
        );
    }

    /** Una pregunta puntuada del criterio dado, con notas privadas. */
    function seedAnsweredQuestion(candidateId: string, score: number): void {
        db.prepare(
            `INSERT INTO interview_question
                 (id, candidate_id, criterion, dimension, question,
                  answer_score, answer_notes, answered_at)
             VALUES (?, ?, 'adaptability', 'velocidad', '¿Qué migraste?',
                     ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`,
        ).run(newId(), candidateId, score, `RESPUESTA PRIVADA ${candidateId}`);
    }

    async function seedTwo(): Promise<[string, string]> {
        await createProcess();
        const a = await createCandidate("Ana Ejemplo");
        const b = await createCandidate("Luis Prueba");
        seedAnalyzed(a, [5, 4, 3, 2, 1]);
        seedAnalyzed(b, [3, 3, 4, 4, 4]);
        return [a, b];
    }

    describe("camino feliz", () => {
        it("200: cabeceras de los candidatos en el orden pedido, comparación con refs resueltas a ids y auditoría sin contenido", async () => {
            const [a, b] = await seedTwo();
            seedAnsweredQuestion(b, 8);

            const res = await request
                .post("/comparison")
                .send({ candidateIds: [b, a] });

            expect(res.status).toBe(200);
            expect(res.body).toMatchObject({
                roleTitle: "Backend Serverless",
                weights: WEIGHTS,
                disclaimer: COMPARISON_DISCLAIMER,
            });
            expect(typeof res.body.generatedAt).toBe("string");

            // Cabeceras: el orden es el pedido y las refs numeran desde C1.
            const [first, second] = res.body.candidates;
            expect(first).toMatchObject({
                ref: "C1",
                candidateId: b,
                name: "Luis Prueba",
                scores: {
                    adaptability: 3,
                    fundamentals: 3,
                    depth: 4,
                    production: 4,
                    stack: 4,
                },
                cvScore: 3.45,
                interviewScore: 8,
                provisional: false,
                confidence: 0.7,
                verdicts: { adaptability: "confirmed", depth: null },
                pendingDoubts: [`Duda pendiente ${b}.`],
            });
            expect(first.overallScore).toBeCloseTo(3.45 * 0.3 + 4 * 0.7, 2);
            expect(first.interviewByCriterion.adaptability).toEqual({
                average: 8,
                answered: 1,
            });
            expect(second).toMatchObject({
                ref: "C2",
                candidateId: a,
                name: "Ana Ejemplo",
                provisional: true,
                interviewScore: null,
            });
            expect(second.overallScore).toBe(second.cvScore);

            // Comparación: las referencias del modelo llegan como ids.
            const { comparison } = res.body;
            expect(comparison.criteria.adaptability).toEqual({
                leaders: [b],
                analysis: "Análisis de adaptability.",
            });
            expect(comparison.criteria.fundamentals.leaders).toEqual([a]);
            expect(comparison.ties).toEqual([
                {
                    candidateIds: [b, a],
                    whatWouldSeparate: "Una entrevista sobre profundidad.",
                },
            ]);
            expect(comparison).toMatchObject({
                evidenceQuality:
                    "C1 se apoya en evidencias explícitas; C2 en inferencias.",
                profiles:
                    "Perfiles complementarios: producción vs adaptabilidad.",
                openQuestions: ["¿Cuánto código produjo en producción?"],
                summary: "Diferencias pequeñas; la entrevista decidirá.",
            });

            // Auditoría: solo conteos y duración, sobre el proceso.
            const events = eventsByAction(db, COMPARED_ACTION);
            expect(events).toHaveLength(1);
            expect(events[0].entity_type).toBe("process");
            const metadata = JSON.parse(events[0].metadata as string);
            expect(metadata.candidates).toBe(2);
            expect(typeof metadata.durationMs).toBe("number");
            expect(JSON.stringify(events[0])).not.toContain("Ana");
        });

        it("el prompt real lleva refs, nombres, resumen, scores, evidencias, dudas y entrevista; y el schema restringe las refs", async () => {
            const [a, b] = await seedTwo();
            seedAnsweredQuestion(a, 6);

            await request
                .post("/comparison")
                .send({ candidateIds: [a, b] })
                .expect(200);

            expect(mock.requests).toHaveLength(1);
            const { body } = mock.requests[0];
            const prompt = body.messages[0].content;
            expect(prompt).not.toContain("{{");
            expect(prompt).toContain("**Backend Serverless**");
            expect(prompt).toContain('"ref": "C1"');
            expect(prompt).toContain('"nombre": "Ana Ejemplo"');
            expect(prompt).toContain(`Resumen profesional de ${a}.`);
            expect(prompt).toContain("Java → TypeScript");
            expect(prompt).toContain(`Rationale adaptabilidad ${a}.`);
            expect(prompt).toContain(`Evidencia explícita ${a}.`);
            expect(prompt).toContain('"tipo": "explicit"');
            expect(prompt).toContain(`Duda pendiente ${b}.`);
            expect(prompt).toContain('"nota_entrevista_global": 6');
            expect(prompt).toContain('"veredicto_entrevista": "confirmed"');
            expect(prompt).toContain('"score_final_provisional": true');

            // Gramática: enum con exactamente las refs de esta comparación.
            const schema = body.response_format.json_schema.schema as {
                properties: {
                    criteria: {
                        properties: {
                            depth: { properties: { leaders: { items: unknown } } };
                        };
                    };
                };
            };
            expect(
                schema.properties.criteria.properties.depth.properties.leaders
                    .items,
            ).toEqual({ type: "string", enum: ["C1", "C2"] });
            expect(body.response_format.json_schema.name).toBe(
                "compare-candidates",
            );
        });

        it("privacidad (§17): ni las notas privadas ni el texto de las respuestas viajan al modelo ni salen en la respuesta", async () => {
            const [a, b] = await seedTwo();
            seedAnsweredQuestion(a, 6);

            const res = await request
                .post("/comparison")
                .send({ candidateIds: [a, b] })
                .expect(200);

            const prompt = mock.requests[0].body.messages[0].content;
            expect(prompt).not.toContain("NOTA PRIVADA");
            expect(prompt).not.toContain("RESPUESTA PRIVADA");
            const serialized = JSON.stringify(res.body);
            expect(serialized).not.toContain("NOTA PRIVADA");
            expect(serialized).not.toContain("RESPUESTA PRIVADA");
        });

        it("hasta MAX_COMPARISON_CANDIDATES candidatos en una sola llamada al modelo", async () => {
            await createProcess();
            const ids: string[] = [];
            for (let i = 0; i < MAX_COMPARISON_CANDIDATES; i++) {
                const id = await createCandidate(`Candidato ${i + 1}`);
                seedAnalyzed(id);
                ids.push(id);
            }

            const res = await request
                .post("/comparison")
                .send({ candidateIds: ids })
                .expect(200);

            expect(mock.requests).toHaveLength(1);
            expect(res.body.candidates.map((c: { ref: string }) => c.ref)).toEqual(
                ["C1", "C2", "C3", "C4", "C5"],
            );
        });

        it("un proceso ARCHIVADO se puede comparar: es lectura, como ranking y export", async () => {
            const [a, b] = await seedTwo();
            await request.post("/process/close").send({}).expect(200);

            await request
                .post("/comparison")
                .send({ candidateIds: [a, b] })
                .expect(200);
        });

        it("no persiste nada: la comparación no deja filas nuevas salvo el evento de auditoría", async () => {
            const [a, b] = await seedTwo();
            const before = countAllRows(db);

            await request
                .post("/comparison")
                .send({ candidateIds: [a, b] })
                .expect(200);

            const after = countAllRows(db);
            expect(after.app_event).toBe(before.app_event + 1);
            expect(after.candidate).toBe(before.candidate);
            expect(after.candidate_score).toBe(before.candidate_score);
            expect(after.interview_question).toBe(before.interview_question);
        });
    });

    describe("validación y errores", () => {
        it("400 INVALID_INPUT con un solo id, ids repetidos, id inválido o cuerpo vacío; sin llamar al modelo", async () => {
            const [a, b] = await seedTwo();

            for (const body of [
                { candidateIds: [a] },
                { candidateIds: [a, a] },
                { candidateIds: [a, "no-es-uuid"] },
                { candidateIds: [a, b], extra: true },
                {},
            ]) {
                const res = await request.post("/comparison").send(body);
                expect(res.status).toBe(400);
                expect(res.body.error.code).toBe("INVALID_INPUT");
            }
            expect(mock.requests).toHaveLength(0);
        });

        it("400 INVALID_INPUT si un candidato no tiene análisis completo; no gasta rate limit", async () => {
            await createProcess();
            const analyzed = await createCandidate("Ana Ejemplo");
            const pending = await createCandidate("Luis Prueba");
            seedAnalyzed(analyzed);

            const res = await request
                .post("/comparison")
                .send({ candidateIds: [analyzed, pending] });
            expect(res.status).toBe(400);
            expect(res.body.error.code).toBe("INVALID_INPUT");
            expect(res.body.error.message).not.toContain("Luis");
            expect(mock.requests).toHaveLength(0);

            // El cupo sigue intacto: se puede consumir entero después.
            for (let i = 0; i < RATE_LIMITS_PER_HOUR.COMPARE; i++) {
                rateLimiter.check(COMPARE_RATE_KEY, RATE_LIMITS_PER_HOUR.COMPARE);
            }
        });

        it("404 NOT_FOUND si un id no existe, está borrado o es de otro proceso", async () => {
            const [a, b] = await seedTwo();

            const missing = await request
                .post("/comparison")
                .send({ candidateIds: [a, newId()] });
            expect(missing.status).toBe(404);

            await request.delete(`/candidates/${b}`).expect(200);
            const deleted = await request
                .post("/comparison")
                .send({ candidateIds: [a, b] });
            expect(deleted.status).toBe(404);

            // Otro proceso seleccionado: los candidatos del anterior no se ven.
            await createProcess();
            const foreign = await request
                .post("/comparison")
                .send({ candidateIds: [a, b] });
            expect(foreign.status).toBe(404);
            expect(mock.requests).toHaveLength(0);
        });

        it("404 NOT_FOUND sin proceso seleccionado", async () => {
            const res = await request
                .post("/comparison")
                .send({ candidateIds: [newId(), newId()] });
            expect(res.status).toBe(404);
            expect(res.body.error.code).toBe("NOT_FOUND");
        });

        it("429 RATE_LIMITED al superar el cupo por hora (§16)", async () => {
            const [a, b] = await seedTwo();
            for (let i = 0; i < RATE_LIMITS_PER_HOUR.COMPARE; i++) {
                rateLimiter.check(COMPARE_RATE_KEY, RATE_LIMITS_PER_HOUR.COMPARE);
            }

            const res = await request
                .post("/comparison")
                .send({ candidateIds: [a, b] });
            expect(res.status).toBe(429);
            expect(res.body.error.code).toBe("RATE_LIMITED");
            expect(mock.requests).toHaveLength(0);
        });

        it("502 LLM_UNAVAILABLE si el modelo falla o devuelve una ref fuera del enum; sin contenido en el error", async () => {
            const [a, b] = await seedTwo();

            responder = () => ({ status: 500 });
            const down = await request
                .post("/comparison")
                .send({ candidateIds: [a, b] });
            expect(down.status).toBe(502);
            expect(down.body.error.code).toBe("LLM_UNAVAILABLE");

            responder = () => {
                const output = validComparison(["C1", "C2"]);
                output.criteria.stack.leaders = ["C7"];
                return chatCompletion(output);
            };
            const stranger = await request
                .post("/comparison")
                .send({ candidateIds: [a, b] });
            expect(stranger.status).toBe(502);
            expect(JSON.stringify(stranger.body)).not.toContain("Ana");
        });
    });
});

function countAllRows(db: Database): Record<string, number> {
    const count = (table: string): number =>
        (
            db.prepare(`SELECT COUNT(*) AS total FROM ${table}`).get() as {
                total: number;
            }
        ).total;
    return {
        app_event: count("app_event"),
        candidate: count("candidate"),
        candidate_score: count("candidate_score"),
        interview_question: count("interview_question"),
    };
}
