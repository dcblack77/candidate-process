import { readdirSync, readFileSync } from "node:fs";
import { Server } from "node:http";
import path from "node:path";
import { createModule, interfaces } from "@expressots/core";
import supertest from "supertest";
import {
    afterAll,
    beforeAll,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from "vitest";
import {
    DOCX_MARKER,
    ensureFixtures,
    FIXTURES_DIR,
    PDF_MARKER,
    SENTINEL_PERSONAL_DATA,
    TXT_MARKER,
} from "../scripts/generate-fixtures";
import { estimateTokens, OUTPUT_MARGIN_TOKENS } from "../src/ai/llm-client";
import { App } from "../src/app";
import { CV_EXTRACT_RATE_KEY } from "../src/cv/extract-cv.usecase";
import { Database, DB } from "../src/db/database";
import { AppEnv, ENV, loadEnv } from "../src/env";
import { RateLimiter } from "../src/security/rate-limit";
import { AuditRepository } from "../src/shared/audit";
import { newId } from "../src/shared/ids";
import {
    MAX_CV_MB,
    MAX_EXTRACTED_CHARS,
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
 * Integración de POST /candidates/:id/cv/extract sobre la app real:
 * supertest + DB :memory: + mock HTTP de llama.cpp (los tests NUNCA hablan
 * con el modelo real). El responder del mock es intercambiable por test.
 */

/** Respuesta válida del modelo para summarize-cv (cumple el schema zod). */
function validSummary() {
    return {
        professional_summary:
            "Perfil backend con transiciones tecnológicas demostradas.",
        evidence: {
            adaptability: [
                {
                    text: "Migración de Java a Node.js con entrega real.",
                    type: "explicit",
                },
            ],
            fundamentals: [
                { text: "Grado en Ingeniería Informática.", type: "explicit" },
            ],
            depth: [],
            production: [
                {
                    text: "Guardias y postmortems en producción.",
                    type: "explicit",
                },
            ],
            stack: [
                {
                    text: "APIs serverless con AWS Lambda y TypeScript.",
                    type: "explicit",
                },
            ],
        },
        technology_transitions: [
            "Java a Node.js con entregas posteriores al cambio.",
        ],
        doubts_for_interview: ["Profundidad real en AWS más allá de Lambda."],
        risks: [],
    };
}

type Responder = (
    request: RecordedRequest,
    index: number,
) => { status: number; body?: unknown };

describe("POST /candidates/:id/cv/extract", () => {
    let db: Database;
    let request: ReturnType<typeof supertest>;
    let server: Server;
    let mock: MockLlm;
    let env: AppEnv;
    const rateLimiter = new RateLimiter();
    let responder: Responder;

    beforeAll(async () => {
        await ensureFixtures();

        mock = await startMockLlm((req, index) => responder(req, index));
        db = createTestDb();
        env = {
            ...loadEnv(),
            LLM_BASE_URL: mock.url,
            // Sin reintentos en tests: el fallo del modelo responde al primer 500.
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
        responder = () => chatCompletion(validSummary());
    });

    async function createProcess(roleContext?: string): Promise<string> {
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

    function fixture(name: string): Buffer {
        return readFileSync(path.join(FIXTURES_DIR, name));
    }

    function extract(
        candidateId: string,
        file: Buffer,
        filename: string,
        contentType?: string,
    ) {
        const req = request.post(`/candidates/${candidateId}/cv/extract`);
        return contentType
            ? req.attach("file", file, { filename, contentType })
            : req.attach("file", file, filename);
    }

    function candidateRow(id: string): {
        cv_summary: string | null;
        cv_evidence: string | null;
        analysis_status: string;
    } {
        return db
            .prepare(
                "SELECT cv_summary, cv_evidence, analysis_status FROM candidate WHERE id = ?",
            )
            .get(id) as never;
    }

    /** Prompt completo enviado al mock en el request `index`. */
    function sentPrompt(index = 0): string {
        return mock.requests[index].body.messages[0].content;
    }

    describe("camino feliz", () => {
        it("TXT: 200, resumen persistido y analysis_status='summarized'", async () => {
            await createProcess("Equipo de plataforma, stack AWS.");
            const id = await createCandidate();

            const res = await extract(
                id,
                fixture("cv-sample.txt"),
                "cv-sample.txt",
            );

            expect(res.status).toBe(200);
            expect(res.body).toMatchObject({
                candidateId: id,
                analysisStatus: "summarized",
                truncated: false,
                cvSummary: validSummary(),
                fileDeleted: true,
            });
            expect(res.body.extractedChars).toBeGreaterThan(0);

            const row = candidateRow(id);
            expect(row.analysis_status).toBe("summarized");
            expect(JSON.parse(row.cv_summary as string)).toEqual(
                validSummary(),
            );
            expect(JSON.parse(row.cv_evidence as string)).toEqual(
                validSummary().evidence,
            );

            // El prompt al modelo local sí lleva el texto del CV y el rol.
            expect(sentPrompt()).toContain(TXT_MARKER);
            expect(sentPrompt()).toContain("Backend Serverless");
            expect(sentPrompt()).toContain("Equipo de plataforma, stack AWS.");

            // Auditoría sin contenido: solo métricas.
            const events = eventsByAction(db, "candidate.cv_extracted");
            expect(events).toHaveLength(1);
            const metadata = JSON.parse(events[0].metadata as string);
            expect(metadata.chars).toBe(res.body.extractedChars);
            expect(metadata.truncated).toBe(false);
            expect(typeof metadata.durationMs).toBe("number");
        });

        it("role_context null: se envía un contexto neutro, nunca '{{role_context}}'", async () => {
            await createProcess();
            const id = await createCandidate();

            const res = await extract(
                id,
                fixture("cv-sample.txt"),
                "cv-sample.txt",
            );

            expect(res.status).toBe(200);
            expect(sentPrompt()).not.toContain("{{");
            expect(sentPrompt()).toContain("(Sin contexto adicional del rol.)");
        });

        it("PDF: extrae el texto real del fixture", async () => {
            await createProcess();
            const id = await createCandidate();

            const res = await extract(
                id,
                fixture("cv-sample.pdf"),
                "cv-sample.pdf",
            );

            expect(res.status).toBe(200);
            expect(res.body.analysisStatus).toBe("summarized");
            expect(sentPrompt()).toContain(PDF_MARKER);
            expect(sentPrompt()).toContain(SENTINEL_PERSONAL_DATA);
        });

        it("DOCX: extrae el texto real del fixture", async () => {
            await createProcess();
            const id = await createCandidate();

            const res = await extract(
                id,
                fixture("cv-sample.docx"),
                "cv-sample.docx",
            );

            expect(res.status).toBe(200);
            expect(res.body.analysisStatus).toBe("summarized");
            expect(sentPrompt()).toContain(DOCX_MARKER);
        });
    });

    describe("validación del archivo", () => {
        it("archivo de más de 10MB responde 413 FILE_TOO_LARGE", async () => {
            await createProcess();
            const id = await createCandidate();

            const big = Buffer.alloc(MAX_CV_MB * 1024 * 1024 + 1, 0x61);
            const res = await extract(id, big, "gigante.txt");

            expect(res.status).toBe(413);
            expect(res.body.error.code).toBe("FILE_TOO_LARGE");
            expect(candidateRow(id).analysis_status).toBe("pending");
            expect(mock.requests).toHaveLength(0);
        });

        it.each(["malware.exe", "notas.md"])(
            "extensión no permitida (%s) responde 415 UNSUPPORTED_MEDIA_TYPE",
            async (filename) => {
                await createProcess();
                const id = await createCandidate();

                const res = await extract(
                    id,
                    Buffer.from("contenido"),
                    filename,
                );

                expect(res.status).toBe(415);
                expect(res.body.error.code).toBe("UNSUPPORTED_MEDIA_TYPE");
                expect(mock.requests).toHaveLength(0);
            },
        );

        it("mimetype que no coincide con la extensión responde 415", async () => {
            await createProcess();
            const id = await createCandidate();

            const res = await extract(
                id,
                fixture("cv-sample.txt"),
                "cv-sample.txt",
                "application/pdf",
            );

            expect(res.status).toBe(415);
            expect(res.body.error.code).toBe("UNSUPPORTED_MEDIA_TYPE");
        });

        it("sin archivo responde 400 INVALID_INPUT", async () => {
            await createProcess();
            const id = await createCandidate();

            const res = await request
                .post(`/candidates/${id}/cv/extract`)
                .field("otraCosa", "sin archivo");

            expect(res.status).toBe(400);
            expect(res.body.error.code).toBe("INVALID_INPUT");
        });

        it("PDF corrupto responde 400 y deja analysis_status='failed' reintentable", async () => {
            await createProcess();
            const id = await createCandidate();

            const res = await extract(
                id,
                Buffer.from("esto no es un pdf"),
                "roto.pdf",
            );

            expect(res.status).toBe(400);
            expect(res.body.error.code).toBe("INVALID_INPUT");
            expect(candidateRow(id).analysis_status).toBe("failed");

            const retry = await extract(
                id,
                fixture("cv-sample.pdf"),
                "cv-sample.pdf",
            );
            expect(retry.status).toBe(200);
            expect(candidateRow(id).analysis_status).toBe("summarized");
        });
    });

    describe("candidato y proceso", () => {
        it("candidato inexistente responde 404", async () => {
            await createProcess();
            const res = await extract(
                newId(),
                fixture("cv-sample.txt"),
                "cv-sample.txt",
            );
            expect(res.status).toBe(404);
            expect(res.body.error.code).toBe("NOT_FOUND");
        });

        it("candidato soft-deleted responde 404", async () => {
            await createProcess();
            const id = await createCandidate();
            await request.delete(`/candidates/${id}`).expect(200);

            const res = await extract(
                id,
                fixture("cv-sample.txt"),
                "cv-sample.txt",
            );
            expect(res.status).toBe(404);
        });

        it("sin proceso activo responde 404", async () => {
            const res = await extract(
                newId(),
                fixture("cv-sample.txt"),
                "cv-sample.txt",
            );
            expect(res.status).toBe(404);
        });

        it("id que no es UUID responde 400", async () => {
            await createProcess();
            const res = await extract(
                "no-es-uuid" as never,
                fixture("cv-sample.txt"),
                "cv.txt",
            );
            expect(res.status).toBe(400);
        });
    });

    describe("rate limit (§16: 20/hora)", () => {
        it("la llamada 21 en la misma hora responde 429 RATE_LIMITED", async () => {
            await createProcess();
            const id = await createCandidate();

            // Consumimos el cupo directamente en el limiter compartido con la
            // app (misma clave): equivale a 20 extracciones en la ventana.
            for (let i = 0; i < RATE_LIMITS_PER_HOUR.EXTRACT; i++) {
                rateLimiter.check(
                    CV_EXTRACT_RATE_KEY,
                    RATE_LIMITS_PER_HOUR.EXTRACT,
                );
            }

            const res = await extract(
                id,
                fixture("cv-sample.txt"),
                "cv-sample.txt",
            );
            expect(res.status).toBe(429);
            expect(res.body.error.code).toBe("RATE_LIMITED");
            expect(mock.requests).toHaveLength(0);
            // El rechazo por rate limit no deja al candidato en 'extracting'.
            expect(candidateRow(id).analysis_status).toBe("pending");
        });
    });

    describe("modelo caído", () => {
        it("502, analysis_status='failed' y el reintento con LLM sano recupera", async () => {
            await createProcess();
            const id = await createCandidate();

            responder = () => ({ status: 500 });
            const res = await extract(
                id,
                fixture("cv-sample.txt"),
                "cv-sample.txt",
            );
            expect(res.status).toBe(502);
            expect(res.body.error.code).toBe("LLM_UNAVAILABLE");
            expect(candidateRow(id).analysis_status).toBe("failed");

            responder = () => chatCompletion(validSummary());
            const retry = await extract(
                id,
                fixture("cv-sample.txt"),
                "cv-sample.txt",
            );
            expect(retry.status).toBe(200);
            expect(retry.body.analysisStatus).toBe("summarized");
            expect(candidateRow(id).analysis_status).toBe("summarized");
        });
    });

    describe("truncado", () => {
        it("texto >50k chars: truncated=true y el prompt cabe en el presupuesto", async () => {
            await createProcess();
            const id = await createCandidate();

            const tail = "FRASE-FINAL-QUE-NO-DEBE-CABER";
            const bigText =
                `${TXT_MARKER}\n` + "relleno sintetico ".repeat(4_000) + tail; // > 70k chars
            expect(bigText.length).toBeGreaterThan(MAX_EXTRACTED_CHARS);

            const res = await extract(
                id,
                Buffer.from(bigText, "utf8"),
                "enorme.txt",
            );

            expect(res.status).toBe(200);
            expect(res.body.truncated).toBe(true);
            expect(res.body.extractedChars).toBe(bigText.length);

            const prompt = sentPrompt();
            expect(prompt).toContain(TXT_MARKER);
            expect(prompt).not.toContain(tail);
            // Presupuesto global: el prompt completo cabe en el contexto
            // menos el margen de salida reservado.
            expect(estimateTokens(prompt)).toBeLessThanOrEqual(
                env.LLM_CONTEXT_TOKENS - OUTPUT_MARGIN_TOKENS,
            );

            const events = eventsByAction(db, "candidate.cv_extracted");
            expect(JSON.parse(events[0].metadata as string).truncated).toBe(
                true,
            );
        });
    });

    describe("no persistencia del CV original (§04/§17)", () => {
        /** Listado recursivo del repo, excluyendo directorios volátiles. */
        function snapshotRepoFiles(): string[] {
            const repoRoot = env.REPO_ROOT;
            const excluded = new Set(["node_modules", "dist", "data", ".git"]);
            const files: string[] = [];
            const walk = (dir: string): void => {
                for (const entry of readdirSync(dir, { withFileTypes: true })) {
                    if (entry.isDirectory()) {
                        if (!excluded.has(entry.name)) {
                            walk(path.join(dir, entry.name));
                        }
                    } else {
                        files.push(
                            path.relative(repoRoot, path.join(dir, entry.name)),
                        );
                    }
                }
            };
            walk(repoRoot);
            return files.sort();
        }

        it("varios extracts no escriben ningún archivo nuevo en el repo", async () => {
            await createProcess();
            const id = await createCandidate();

            const before = snapshotRepoFiles();
            await extract(id, fixture("cv-sample.txt"), "cv-sample.txt").expect(
                200,
            );
            await extract(id, fixture("cv-sample.pdf"), "cv-sample.pdf").expect(
                200,
            );
            await extract(
                id,
                fixture("cv-sample.docx"),
                "cv-sample.docx",
            ).expect(200);
            const after = snapshotRepoFiles();

            expect(after).toEqual(before);
        });

        it("el texto crudo del CV (frase centinela) no queda en la DB", async () => {
            await createProcess();
            const id = await createCandidate();

            await extract(id, fixture("cv-sample.txt"), "cv-sample.txt").expect(
                200,
            );

            // La centinela SÍ viajó al modelo local (única salida permitida)…
            expect(sentPrompt()).toContain(SENTINEL_PERSONAL_DATA);

            // …pero no sobrevive en ninguna tabla: ni el dato personal ni el
            // texto crudo del fixture.
            const tables = ["candidate", "process", "app_event"];
            for (const table of tables) {
                const dump = JSON.stringify(
                    db.prepare(`SELECT * FROM ${table}`).all(),
                );
                expect(dump).not.toContain(SENTINEL_PERSONAL_DATA);
                expect(dump).not.toContain(TXT_MARKER);
            }
        });

        it("los logs no contienen la frase centinela ni el texto del CV", async () => {
            await createProcess();
            const id = await createCandidate();

            const spies = (["log", "info", "warn", "error"] as const).map(
                (level) =>
                    vi
                        .spyOn(console, level)
                        .mockImplementation(() => undefined),
            );
            try {
                await extract(
                    id,
                    fixture("cv-sample.txt"),
                    "cv-sample.txt",
                ).expect(200);
                // También el camino de error, que es donde más fácil se fuga.
                responder = () => ({ status: 500 });
                await extract(
                    id,
                    fixture("cv-sample.txt"),
                    "cv-sample.txt",
                ).expect(502);

                const logged = spies
                    .flatMap((spy) => spy.mock.calls)
                    .flat()
                    .map((value) => String(value))
                    .join("\n");
                expect(logged).not.toContain(SENTINEL_PERSONAL_DATA);
                expect(logged).not.toContain(TXT_MARKER);
                expect(logged).not.toContain("Ana Ejemplo");
            } finally {
                spies.forEach((spy) => spy.mockRestore());
            }
        });
    });
});
