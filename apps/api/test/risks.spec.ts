import { Server } from "node:http";
import { createModule, interfaces } from "@expressots/core";
import supertest from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
    DETECT_RISKS_JSON_SCHEMA,
    DetectRisksResult,
    detectRisksZodSchema,
    MAX_RISK_ITEMS,
    MAX_RISK_TEXT_LENGTH,
} from "../src/ai/schemas/detect-risks";
import { App } from "../src/app";
import { Database, DB } from "../src/db/database";
import { AppEnv, ENV, loadEnv } from "../src/env";
import {
    RISKS_DETECTED_ACTION,
    RISKS_RATE_KEY,
} from "../src/risks/detect-risks.usecase";
import { RateLimiter } from "../src/security/rate-limit";
import { AuditRepository } from "../src/shared/audit";
import {
    MAX_RISK_DETECTIONS_PER_CANDIDATE,
    RATE_LIMITS_PER_HOUR,
} from "../src/shared/limits";
import { countRows, eventsByAction, resetDb } from "./app-helpers";
import {
    chatCompletion,
    MockLlm,
    RecordedRequest,
    startMockLlm,
} from "./ai-helpers";
import { createTestDb } from "./helpers";

/**
 * Integración de POST/GET /candidates/:id/risks sobre la app real: supertest
 * + DB :memory: + mock HTTP de llama.cpp.
 *
 * Usa la App real con RisksModule registrado y sustituye únicamente el módulo
 * transversal para trabajar con SQLite :memory: y el mock local del modelo.
 */

const SEEDED_SUMMARY = {
    professional_summary:
        "Backend con 3 años en Java en el sector bancario y una migración reciente a Node.js sobre AWS Lambda.",
    experience: [
        {
            role: "Desarrollador backend",
            stack: ["Java", "Spring", "Oracle"],
            highlights: ["Mantenimiento de un core bancario"],
        },
        {
            role: "Desarrollador Node.js",
            stack: ["Node.js", "AWS Lambda", "DynamoDB"],
        },
    ],
};

/** Salida válida del modelo con un riesgo explícito bien apoyado y una laguna. */
function validRisks(): DetectRisksResult {
    return {
        risks: [
            {
                category: "unproven_transition",
                criterion: "adaptability",
                severity: "medium",
                concern:
                    "Declara una migración reciente a Node.js sin entregables descritos.",
                evidence: {
                    text: "migración reciente a Node.js sobre AWS Lambda",
                    type: "explicit",
                },
                interview_check:
                    "Pedir qué entregó tras pasar a Node.js y en cuánto tiempo.",
            },
        ],
        gaps: [
            {
                criterion: "production",
                missing: "Si ha operado sistemas en producción o atendido incidentes.",
                why_it_matters: "El rol tiene guardias sobre servicios vivos.",
                interview_check: "Pedir un incidente real que resolviera y cómo.",
            },
        ],
        confidence: 0.7,
    };
}

type Responder = (
    request: RecordedRequest,
    index: number,
) => { status: number; body?: unknown };

describe("/candidates/:id/risks", () => {
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
        responder = () => chatCompletion(validRisks());
    });

    async function createProcess(
        roleContext: string | undefined = "Equipo de pagos. Guardias sobre servicios vivos en AWS.",
    ): Promise<string> {
        const res = await request
            .post("/process")
            .send({ roleTitle: "Backend Serverless", roleContext });
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
        db.prepare(
            `UPDATE candidate
             SET cv_summary = ?, cv_evidence = '{}', analysis_status = 'summarized'
             WHERE id = ?`,
        ).run(JSON.stringify(SEEDED_SUMMARY), candidateId);
    }

    function riskRow(candidateId: string): Record<string, unknown> | undefined {
        return db
            .prepare(
                "SELECT * FROM candidate_risk_analysis WHERE candidate_id = ?",
            )
            .get(candidateId) as Record<string, unknown> | undefined;
    }

    describe("camino feliz", () => {
        it("200: llama al modelo con resumen, rol y contexto; persiste una fila y responde el DTO", async () => {
            await createProcess();
            const id = await createCandidate();
            seedSummary(id);

            const res = await request.post(`/candidates/${id}/risks`);

            expect(res.status).toBe(200);
            expect(res.body).toMatchObject({
                candidateId: id,
                regenerationsUsed: 1,
                regenerationsLimit: MAX_RISK_DETECTIONS_PER_CANDIDATE,
                analysis: {
                    confidence: 0.7,
                    risks: [
                        {
                            category: "unproven_transition",
                            criterion: "adaptability",
                            severity: "medium",
                            concern:
                                "Declara una migración reciente a Node.js sin entregables descritos.",
                            evidence: {
                                text: "migración reciente a Node.js sobre AWS Lambda",
                                type: "explicit",
                            },
                            interviewCheck:
                                "Pedir qué entregó tras pasar a Node.js y en cuánto tiempo.",
                        },
                    ],
                    gaps: [
                        {
                            criterion: "production",
                            missing:
                                "Si ha operado sistemas en producción o atendido incidentes.",
                            whyItMatters:
                                "El rol tiene guardias sobre servicios vivos.",
                            interviewCheck:
                                "Pedir un incidente real que resolviera y cómo.",
                        },
                    ],
                    stats: {
                        risks: 1,
                        gaps: 1,
                        explicit: 1,
                        inferred: 0,
                        downgradedToInferred: 0,
                    },
                },
            });
            expect(typeof res.body.analysis.createdAt).toBe("string");
            expect(typeof res.body.analysis.updatedAt).toBe("string");

            // El prompt: resumen + título + contexto del rol, y el schema
            // estricto de detect-risks como gramática.
            expect(mock.requests).toHaveLength(1);
            const [req] = mock.requests;
            const prompt = req.body.messages[0].content;
            expect(prompt).toContain("Backend Serverless");
            expect(prompt).toContain("Equipo de pagos.");
            expect(prompt).toContain("core bancario");
            expect(req.body.response_format.json_schema.schema).toEqual(
                DETECT_RISKS_JSON_SCHEMA,
            );

            // Persistencia: una fila con las listas en JSON (camelCase).
            const row = riskRow(id);
            expect(row).toBeDefined();
            expect(row?.confidence).toBe(0.7);
            expect(JSON.parse(row?.risks as string)[0]).toMatchObject({
                interviewCheck:
                    "Pedir qué entregó tras pasar a Node.js y en cuánto tiempo.",
            });
            expect(JSON.parse(row?.gaps as string)).toHaveLength(1);
        });

        it("GET devuelve la última detección persistida y los contadores", async () => {
            await createProcess();
            const id = await createCandidate();
            seedSummary(id);
            await request.post(`/candidates/${id}/risks`).expect(200);

            const res = await request.get(`/candidates/${id}/risks`);
            expect(res.status).toBe(200);
            expect(res.body).toMatchObject({
                candidateId: id,
                regenerationsUsed: 1,
                regenerationsLimit: MAX_RISK_DETECTIONS_PER_CANDIDATE,
            });
            expect(res.body.analysis.risks).toHaveLength(1);
            expect(res.body.analysis.gaps).toHaveLength(1);
            expect(res.body.analysis.stats.explicit).toBe(1);
        });

        it("GET sin detección previa responde 200 con analysis null (no 404)", async () => {
            await createProcess();
            const id = await createCandidate();

            const res = await request.get(`/candidates/${id}/risks`);
            expect(res.status).toBe(200);
            expect(res.body).toEqual({
                candidateId: id,
                analysis: null,
                regenerationsUsed: 0,
                regenerationsLimit: MAX_RISK_DETECTIONS_PER_CANDIDATE,
            });
        });

        it("regenerar sobrescribe la fila (una por candidato) y conserva created_at", async () => {
            await createProcess();
            const id = await createCandidate();
            seedSummary(id);
            await request.post(`/candidates/${id}/risks`).expect(200);
            const first = riskRow(id);

            responder = () =>
                chatCompletion({ risks: [], gaps: [], confidence: 0.9 });
            const res = await request.post(`/candidates/${id}/risks`);
            expect(res.status).toBe(200);
            expect(res.body.regenerationsUsed).toBe(2);
            expect(res.body.analysis.risks).toEqual([]);
            expect(res.body.analysis.gaps).toEqual([]);

            expect(countRows(db, "candidate_risk_analysis")).toBe(1);
            const second = riskRow(id);
            expect(second?.id).toBe(first?.id);
            expect(second?.created_at).toBe(first?.created_at);
            expect(second?.confidence).toBe(0.9);
        });

        it("sin contexto de rol el prompt lleva el texto neutro, no un hueco", async () => {
            await createProcess(undefined);
            const id = await createCandidate();
            seedSummary(id);

            await request.post(`/candidates/${id}/risks`).expect(200);
            const prompt = mock.requests[0].body.messages[0].content;
            expect(prompt).not.toMatch(/\{\{\s*role_context\s*\}\}/);
            expect(prompt).toMatch(/Contexto del rol:\s*\S/);
        });

        it("no requiere análisis previo: basta el cv_summary", async () => {
            await createProcess();
            const id = await createCandidate();
            seedSummary(id);
            expect(
                db
                    .prepare(
                        "SELECT COUNT(*) AS n FROM candidate_score WHERE candidate_id = ?",
                    )
                    .get(id),
            ).toEqual({ n: 0 });

            await request.post(`/candidates/${id}/risks`).expect(200);
        });
    });

    describe("verificación de evidencia (no inventar riesgos)", () => {
        it("un `explicit` que el resumen no sostiene se persiste y se devuelve como `inferred`", async () => {
            await createProcess();
            const id = await createCandidate();
            seedSummary(id);

            const invented = validRisks();
            invented.risks[0].evidence = {
                text: "Lideró un equipo de doce personas en Kubernetes",
                type: "explicit",
            };
            responder = () => chatCompletion(invented);

            const res = await request.post(`/candidates/${id}/risks`);
            expect(res.status).toBe(200);
            expect(res.body.analysis.risks).toHaveLength(1);
            expect(res.body.analysis.risks[0].evidence.type).toBe("inferred");
            expect(res.body.analysis.stats).toMatchObject({
                explicit: 0,
                inferred: 1,
                downgradedToInferred: 1,
            });

            // Lo persistido ya está corregido: nadie vuelve a leer la
            // etiqueta original del modelo.
            const row = riskRow(id);
            expect(JSON.parse(row?.risks as string)[0].evidence.type).toBe(
                "inferred",
            );
            expect(JSON.parse(row?.stats as string).downgradedToInferred).toBe(
                1,
            );
        });

        it("una evidencia apoyada en el contexto del rol sigue siendo explícita", async () => {
            await createProcess("El equipo usa Step Functions y EventBridge.");
            const id = await createCandidate();
            seedSummary(id);

            const withRoleEvidence = validRisks();
            withRoleEvidence.risks[0] = {
                ...withRoleEvidence.risks[0],
                category: "role_gap",
                criterion: "stack",
                evidence: {
                    text: "el equipo usa Step Functions y EventBridge",
                    type: "explicit",
                },
            };
            responder = () => chatCompletion(withRoleEvidence);

            const res = await request.post(`/candidates/${id}/risks`);
            expect(res.status).toBe(200);
            expect(res.body.analysis.risks[0].evidence.type).toBe("explicit");
            expect(res.body.analysis.stats.downgradedToInferred).toBe(0);
        });
    });

    describe("auditoría (§17)", () => {
        it("registra candidate.risks_detected solo con conteos, sin contenido", async () => {
            await createProcess();
            const id = await createCandidate();
            seedSummary(id);

            await request.post(`/candidates/${id}/risks`).expect(200);

            const events = eventsByAction(db, RISKS_DETECTED_ACTION);
            expect(events).toHaveLength(1);
            expect(events[0].entity_type).toBe("candidate");
            expect(events[0].entity_id).toBe(id);
            const metadata = JSON.parse(events[0].metadata as string);
            expect(metadata).toMatchObject({
                regeneration: 1,
                confidence: 0.7,
                risks: 1,
                gaps: 1,
                downgradedToInferred: 0,
            });
            expect(typeof metadata.durationMs).toBe("number");
            const serialized = events[0].metadata as string;
            expect(serialized).not.toContain("Node.js");
            expect(serialized).not.toContain("bancario");
            expect(serialized).not.toContain("guardias");
        });
    });

    describe("límite de detecciones (§16: 5 por candidato)", () => {
        it("la 6ª detección responde 422 LIMIT_EXCEEDED sin llamar al modelo", async () => {
            await createProcess();
            const id = await createCandidate();
            seedSummary(id);

            for (let i = 0; i < MAX_RISK_DETECTIONS_PER_CANDIDATE; i++) {
                await request.post(`/candidates/${id}/risks`).expect(200);
            }
            expect(mock.requests).toHaveLength(
                MAX_RISK_DETECTIONS_PER_CANDIDATE,
            );

            const res = await request.post(`/candidates/${id}/risks`);
            expect(res.status).toBe(422);
            expect(res.body.error.code).toBe("LIMIT_EXCEEDED");
            expect(mock.requests).toHaveLength(
                MAX_RISK_DETECTIONS_PER_CANDIDATE,
            );

            // GET refleja el tope alcanzado.
            const get = await request.get(`/candidates/${id}/risks`);
            expect(get.body.regenerationsUsed).toBe(
                MAX_RISK_DETECTIONS_PER_CANDIDATE,
            );
        });

        it("el límite es por candidato: otro candidato empieza de cero", async () => {
            await createProcess();
            const first = await createCandidate("Uno");
            const second = await createCandidate("Dos");
            seedSummary(first);
            seedSummary(second);

            for (let i = 0; i < MAX_RISK_DETECTIONS_PER_CANDIDATE; i++) {
                await request.post(`/candidates/${first}/risks`).expect(200);
            }
            const res = await request.post(`/candidates/${second}/risks`);
            expect(res.status).toBe(200);
            expect(res.body.regenerationsUsed).toBe(1);
        });
    });

    describe("validaciones", () => {
        it("sin cv_summary responde 400 INVALID_INPUT y no llama al modelo", async () => {
            await createProcess();
            const id = await createCandidate();

            const res = await request.post(`/candidates/${id}/risks`);
            expect(res.status).toBe(400);
            expect(res.body.error.code).toBe("INVALID_INPUT");
            expect(mock.requests).toHaveLength(0);
            expect(riskRow(id)).toBeUndefined();
        });

        it("candidato inexistente responde 404 (POST y GET)", async () => {
            await createProcess();
            const ghost = "11111111-1111-4111-8111-111111111111";
            const post = await request.post(`/candidates/${ghost}/risks`);
            expect(post.status).toBe(404);
            const get = await request.get(`/candidates/${ghost}/risks`);
            expect(get.status).toBe(404);
        });

        it("candidato de OTRO proceso responde 404", async () => {
            await createProcess();
            const id = await createCandidate();
            seedSummary(id);
            // Se abre y selecciona un segundo proceso: el candidato ya no
            // pertenece al seleccionado.
            await createProcess();

            const res = await request.post(`/candidates/${id}/risks`);
            expect(res.status).toBe(404);
            expect(mock.requests).toHaveLength(0);
        });

        it("sin proceso seleccionado responde 404", async () => {
            const res = await request.post(
                "/candidates/11111111-1111-4111-8111-111111111111/risks",
            );
            expect(res.status).toBe(404);
        });

        it("id que no es UUID responde 400", async () => {
            await createProcess();
            const res = await request.post("/candidates/no-es-uuid/risks");
            expect(res.status).toBe(400);
            expect(res.body.error.code).toBe("INVALID_INPUT");
        });

        it("proceso archivado: POST responde 409 PROCESS_CLOSED, GET sigue funcionando", async () => {
            await createProcess();
            const id = await createCandidate();
            seedSummary(id);
            await request.post(`/candidates/${id}/risks`).expect(200);
            await request.post("/process/close").expect(200);

            const post = await request.post(`/candidates/${id}/risks`);
            expect(post.status).toBe(409);
            expect(post.body.error.code).toBe("PROCESS_CLOSED");
            expect(mock.requests).toHaveLength(1);

            const get = await request.get(`/candidates/${id}/risks`);
            expect(get.status).toBe(200);
            expect(get.body.analysis.risks).toHaveLength(1);
        });
    });

    describe("modelo caído o inválido", () => {
        it("500 del modelo → 502 LLM_UNAVAILABLE, nada persistido, no consume detecciones", async () => {
            await createProcess();
            const id = await createCandidate();
            seedSummary(id);

            responder = () => ({ status: 500 });
            const res = await request.post(`/candidates/${id}/risks`);
            expect(res.status).toBe(502);
            expect(res.body.error.code).toBe("LLM_UNAVAILABLE");
            expect(riskRow(id)).toBeUndefined();
            expect(eventsByAction(db, RISKS_DETECTED_ACTION)).toHaveLength(0);

            responder = () => chatCompletion(validRisks());
            const retry = await request.post(`/candidates/${id}/risks`);
            expect(retry.status).toBe(200);
            expect(retry.body.regenerationsUsed).toBe(1);
        });

        it("el modelo cuela un campo fuera del schema (score) → 502 y nada persistido", async () => {
            await createProcess();
            const id = await createCandidate();
            seedSummary(id);

            responder = () =>
                chatCompletion({ ...validRisks(), final_score: 4.2 });
            const res = await request.post(`/candidates/${id}/risks`);
            expect(res.status).toBe(502);
            expect(riskRow(id)).toBeUndefined();
        });

        it("una categoría desconocida no pasa el schema", async () => {
            await createProcess();
            const id = await createCandidate();
            seedSummary(id);

            const bad = validRisks();
            (bad.risks[0] as { category: string }).category = "otra_cosa";
            responder = () => chatCompletion(bad);
            const res = await request.post(`/candidates/${id}/risks`);
            expect(res.status).toBe(502);
        });
    });

    describe("rate limit (§16: 30/hora)", () => {
        it("la llamada 31 en la misma hora responde 429 RATE_LIMITED", async () => {
            await createProcess();
            const id = await createCandidate();
            seedSummary(id);

            for (let i = 0; i < RATE_LIMITS_PER_HOUR.RISKS; i++) {
                rateLimiter.check(RISKS_RATE_KEY, RATE_LIMITS_PER_HOUR.RISKS);
            }

            const res = await request.post(`/candidates/${id}/risks`);
            expect(res.status).toBe(429);
            expect(res.body.error.code).toBe("RATE_LIMITED");
            expect(mock.requests).toHaveLength(0);
        });
    });

    describe("purga (§16)", () => {
        it("borrar el proceso arrastra la detección por CASCADE", async () => {
            await createProcess();
            const id = await createCandidate();
            seedSummary(id);
            await request.post(`/candidates/${id}/risks`).expect(200);
            expect(countRows(db, "candidate_risk_analysis")).toBe(1);

            await request
                .delete("/process")
                .send({ confirmDelete: true })
                .expect(200);
            expect(countRows(db, "candidate_risk_analysis")).toBe(0);
        });
    });
});

describe("schema detect-risks (espejo zod / JSON Schema)", () => {
    it("acepta la salida válida y rechaza texto por encima del tope", () => {
        expect(detectRisksZodSchema.safeParse(validRisks()).success).toBe(true);
        const long = validRisks();
        long.risks[0].concern = "x".repeat(MAX_RISK_TEXT_LENGTH + 1);
        expect(detectRisksZodSchema.safeParse(long).success).toBe(false);
    });

    it("rechaza más de MAX_RISK_ITEMS riesgos", () => {
        const many = validRisks();
        many.risks = Array.from({ length: MAX_RISK_ITEMS + 1 }, () => ({
            ...validRisks().risks[0],
        }));
        expect(detectRisksZodSchema.safeParse(many).success).toBe(false);
    });

    it("el JSON Schema no admite propiedades extra en ningún nivel", () => {
        expect(DETECT_RISKS_JSON_SCHEMA.additionalProperties).toBe(false);
        expect(
            DETECT_RISKS_JSON_SCHEMA.properties.risks.items.additionalProperties,
        ).toBe(false);
        expect(
            DETECT_RISKS_JSON_SCHEMA.properties.gaps.items.additionalProperties,
        ).toBe(false);
    });
});
