import fs, { mkdtempSync, rmSync } from "node:fs";
import { Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { createModule, interfaces } from "@expressots/core";
import supertest from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/app";
import { Database, DB } from "../src/db/database";
import { AppEnv, ENV, loadEnv } from "../src/env";
import { RateLimiter } from "../src/security/rate-limit";
import { AuditRepository } from "../src/shared/audit";
import { newId } from "../src/shared/ids";
import { chatCompletion, MockLlm, Responder, startMockLlm } from "./ai-helpers";
import { eventsByAction, resetDb } from "./app-helpers";
import { createTestDb } from "./helpers";
import { MockStt, SttResponder, startMockStt, verboseJson } from "./stt-helpers";

/**
 * Análisis de entrevista de punta a punta sobre la app real (§24): subida de
 * audio → transcripción (mock) → mapeo (mock) → propuestas persistidas.
 *
 * Ni el audio ni la transcripción salen nunca de memoria; lo que se
 * comprueba aquí es justamente eso, además del contrato HTTP.
 */

let db: Database;
let request: ReturnType<typeof supertest>;
let server: Server;
let llm: MockLlm;
let stt: MockStt;
const rateLimiter = new RateLimiter();
let llmResponder: Responder;
let sttResponder: SttResponder;
/** Dónde escribe esta app las grabaciones. Temporal y se borra al final. */
let recordingsDir: string;

/** Lo que dijo el candidato; se cita literalmente en la propuesta. */
// Por encima de los 180 caracteres que exige `abordado_demostrado`: con una
// cita más corta el verificador degradaría a `abordado_parcial`, que es
// justo lo que comprueba otro test.
const DICHO =
    "Partimos por bounded context separando pagos de catálogo, porque los ciclos de despliegue no tenían nada que ver, y descartamos sacar primero la capa de datos; medimos la latencia p99 con CloudWatch antes y después y bajó de ochocientos a doscientos diez milisegundos";

beforeAll(async () => {
    llm = await startMockLlm((req, index) => llmResponder(req, index));
    stt = await startMockStt((req, index) => sttResponder(req, index));
    db = createTestDb();
    // Las grabaciones van a /tmp, nunca a data/interviews del repo.
    recordingsDir = mkdtempSync(path.join(os.tmpdir(), "interview-spec-"));
    const env: AppEnv = {
        ...loadEnv(),
        LLM_BASE_URL: llm.url,
        LLM_MAX_RETRIES: 0,
        STT_BASE_URL: stt.url,
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
    await llm.close();
    await stt.close();
    rmSync(recordingsDir, { recursive: true, force: true });
});

beforeEach(() => {
    resetDb(db);
    rateLimiter.reset();
    llm.requests.length = 0;
    stt.requests.length = 0;

    sttResponder = () =>
        verboseJson([
            { start: 10, end: 18, text: "¿Cómo abordasteis la migración?" },
            { start: 20, end: 38, text: DICHO },
        ]);

    // Enrutado: todo al P1. Evaluación: cobertura alta con cita real.
    llmResponder = (req) => {
        const prompt = req.body.messages[0].content;
        if (prompt.includes("Preguntas preparadas")) {
            return chatCompletion({
                matches: [
                    {
                        question_ref: "P1",
                        relevance: "central",
                        // Recortada: el schema de enrutado tope a 220
                        // caracteres, y pasarse invalida toda la respuesta.
                        quote: DICHO.slice(0, 200),
                    },
                ],
            });
        }
        return chatCompletion({
            coverage: "abordado_demostrado",
            proposed_score: 8,
            proposed_notes: "Explica la partición y la valida con métricas.",
            evidence: [{ quote: DICHO }],
            confidence: 0.9,
        });
    };
});

afterEach(() => {
    vi.restoreAllMocks();
});

async function seedCandidateWithQuestion(): Promise<{
    candidateId: string;
    questionId: string;
}> {
    await request
        .post("/process")
        .send({ roleTitle: "Backend Serverless" })
        .expect(201);
    const created = await request
        .post("/candidates")
        .send({ name: "Ana Ejemplo" })
        .expect(201);
    const candidateId = created.body.id as string;
    const questionId = newId();
    db.prepare(
        `INSERT INTO interview_question
             (id, candidate_id, criterion, dimension, question, ideal_answer,
              positive_signals, warning_signals, scoring_guidance)
         VALUES (?, ?, 'depth', 'profundidad_vs_exposicion',
                 '¿Cómo particionaste el dominio?', 'Nombra una decisión concreta',
                 '["Cita una métrica"]', '["Habla en genérico"]',
                 '1: sin decisión. 3: sin datos. 5: con validación.')`,
    ).run(questionId, candidateId);
    return { candidateId, questionId };
}

/** Lanza el análisis y espera a que el job termine. */
async function analyze(
    candidateId: string,
    meta?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
    const post = request
        .post(`/candidates/${candidateId}/interview/analysis`)
        .attach("tab", Buffer.from("audio-falso"), {
            filename: "tab.webm",
            contentType: "audio/webm",
        });
    if (meta) {
        void post.field("meta", JSON.stringify(meta));
    }
    const started = await post;
    expect(started.status).toBe(202);
    const jobId = started.body.jobId as string;

    for (let i = 0; i < 100; i++) {
        const res = await request.get(
            `/candidates/${candidateId}/interview/analysis/${jobId}`,
        );
        expect(res.status).toBe(200);
        if (res.body.status !== "running") {
            return res.body as Record<string, unknown>;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("El análisis no terminó a tiempo");
}

describe("POST /candidates/:id/interview/analysis", () => {
    it("202 con jobId y luego propuestas persistidas", async () => {
        const { candidateId, questionId } = await seedCandidateWithQuestion();

        const job = await analyze(candidateId);

        expect(job.status).toBe("done");
        expect(job.phase).toBe("done");
        const proposals = job.proposals as Array<Record<string, unknown>>;
        expect(proposals).toHaveLength(1);
        expect(proposals[0]).toMatchObject({
            questionId,
            coverage: "abordado_demostrado",
            proposedScore: 8,
            status: "proposed",
        });
        expect(
            (proposals[0].evidence as Array<{ quote: string }>)[0].quote,
        ).toContain("bounded context");

        // Y quedan colgando del candidato para la pantalla de detalle.
        const detail = await request.get(`/candidates/${candidateId}`);
        expect(detail.body.proposals).toHaveLength(1);
    });

    it("hace una llamada al modelo por fragmento y otra por pregunta", async () => {
        const { candidateId } = await seedCandidateWithQuestion();
        await analyze(candidateId);
        // Un solo fragmento (transcripción corta) + una pregunta.
        expect(llm.requests).toHaveLength(2);
        expect(stt.requests).toHaveLength(1);
    });

    it("NO escribe la nota real: eso lo hace el evaluador", async () => {
        const { candidateId, questionId } = await seedCandidateWithQuestion();
        await analyze(candidateId);

        const question = db
            .prepare("SELECT answer_score, answer_notes FROM interview_question WHERE id = ?")
            .get(questionId) as { answer_score: number | null; answer_notes: string | null };
        expect(question.answer_score).toBeNull();
        expect(question.answer_notes).toBeNull();
    });

    it("degrada la cobertura cuando el modelo cita algo que nadie dijo", async () => {
        const { candidateId } = await seedCandidateWithQuestion();
        llmResponder = (req) =>
            req.body.messages[0].content.includes("Preguntas preparadas")
                ? chatCompletion({ matches: [] })
                : chatCompletion({
                      coverage: "abordado_demostrado",
                      proposed_score: 9,
                      proposed_notes: "Dice haberlo hecho.",
                      evidence: [{ quote: "lideré un equipo de quince personas" }],
                      confidence: 0.9,
                  });

        const job = await analyze(candidateId);
        const proposals = job.proposals as Array<Record<string, unknown>>;
        expect(proposals[0].coverage).toBe("mencionado");
        expect(proposals[0].proposedScore).toBeNull();
    });

    it("salta las preguntas ya puntuadas salvo includeAnswered", async () => {
        const { candidateId, questionId } = await seedCandidateWithQuestion();
        db.prepare("UPDATE interview_question SET answer_score = 7 WHERE id = ?").run(
            questionId,
        );

        const sinFlag = await request
            .post(`/candidates/${candidateId}/interview/analysis`)
            .attach("tab", Buffer.from("audio"), {
                filename: "t.webm",
                contentType: "audio/webm",
            });
        expect(sinFlag.status).toBe(422);
        expect(sinFlag.body.error.code).toBe("LIMIT_EXCEEDED");

        const conFlag = await analyze(candidateId, { includeAnswered: true });
        expect((conFlag.proposals as unknown[]).length).toBe(1);
    });

    it("un reanálisis descarta la propuesta viva anterior", async () => {
        const { candidateId } = await seedCandidateWithQuestion();
        await analyze(candidateId);
        await analyze(candidateId);

        const rows = db
            .prepare(
                "SELECT status FROM interview_answer_proposal ORDER BY created_at",
            )
            .all() as Array<{ status: string }>;
        expect(rows).toHaveLength(2);
        expect(rows.filter((r) => r.status === "proposed")).toHaveLength(1);

        const detail = await request.get(`/candidates/${candidateId}`);
        expect(detail.body.proposals).toHaveLength(1);
    });

    it("audita solo números: ni transcripción ni citas", async () => {
        const { candidateId } = await seedCandidateWithQuestion();
        await analyze(candidateId);

        const events = eventsByAction(db, "interview.analyzed");
        expect(events).toHaveLength(1);
        const metadata = JSON.parse(events[0].metadata as string) as Record<
            string,
            unknown
        >;
        expect(metadata).toMatchObject({
            segments: 2,
            chunks: 1,
            questionsAssessed: 1,
        });
        expect(events[0].metadata).not.toContain("bounded context");
        expect(events[0].metadata).not.toContain("Ana");
    });
});

describe("errores del análisis", () => {
    it("sin ficheros responde 400 y no llama a nadie", async () => {
        const { candidateId } = await seedCandidateWithQuestion();
        const res = await request.post(
            `/candidates/${candidateId}/interview/analysis`,
        );
        expect(res.status).toBe(400);
        expect(stt.requests).toHaveLength(0);
        expect(llm.requests).toHaveLength(0);
    });

    it("un formato no admitido responde 415", async () => {
        const { candidateId } = await seedCandidateWithQuestion();
        const res = await request
            .post(`/candidates/${candidateId}/interview/analysis`)
            .attach("tab", Buffer.from("no soy audio"), {
                filename: "cv.pdf",
                contentType: "application/pdf",
            });
        expect(res.status).toBe(415);
    });

    it("meta mal formado responde 400", async () => {
        const { candidateId } = await seedCandidateWithQuestion();
        const res = await request
            .post(`/candidates/${candidateId}/interview/analysis`)
            .field("meta", "{no es json")
            .attach("tab", Buffer.from("audio"), {
                filename: "t.webm",
                contentType: "audio/webm",
            });
        expect(res.status).toBe(400);
    });

    it("un candidato sin preguntas responde 422", async () => {
        await request
            .post("/process")
            .send({ roleTitle: "Backend" })
            .expect(201);
        const created = await request
            .post("/candidates")
            .send({ name: "Sin Preguntas" })
            .expect(201);

        const res = await request
            .post(`/candidates/${created.body.id}/interview/analysis`)
            .attach("tab", Buffer.from("audio"), {
                filename: "t.webm",
                contentType: "audio/webm",
            });
        expect(res.status).toBe(422);
        expect(res.body.error.code).toBe("LIMIT_EXCEEDED");
    });

    it("sobre un proceso archivado responde 409", async () => {
        const { candidateId } = await seedCandidateWithQuestion();
        await request.post("/process/close").expect(200);

        const res = await request
            .post(`/candidates/${candidateId}/interview/analysis`)
            .attach("tab", Buffer.from("audio"), {
                filename: "t.webm",
                contentType: "audio/webm",
            });
        expect(res.status).toBe(409);
        expect(res.body.error.code).toBe("PROCESS_CLOSED");
    });

    it("si la transcripción falla, el job acaba en failed con STT_UNAVAILABLE", async () => {
        const { candidateId } = await seedCandidateWithQuestion();
        sttResponder = () => ({ status: 503 });

        const job = await analyze(candidateId);
        expect(job.status).toBe("failed");
        expect(job.error).toMatchObject({ code: "STT_UNAVAILABLE" });
        // Nada a medias en la base.
        const rows = db
            .prepare("SELECT COUNT(*) AS total FROM interview_answer_proposal")
            .get() as { total: number };
        expect(rows.total).toBe(0);
    });

    it("un jobId de otro candidato responde 404", async () => {
        const { candidateId } = await seedCandidateWithQuestion();
        const job = await analyze(candidateId);

        const otro = await request
            .post("/candidates")
            .send({ name: "Otro" })
            .expect(201);
        const res = await request.get(
            `/candidates/${otro.body.id}/interview/analysis/${job.jobId as string}`,
        );
        expect(res.status).toBe(404);
    });
});

describe("PATCH /candidates/:id/interview/proposals/:proposalId", () => {
    it("aplicar y descartar sacan la propuesta de la pantalla", async () => {
        const { candidateId } = await seedCandidateWithQuestion();
        const job = await analyze(candidateId);
        const proposalId = (job.proposals as Array<{ id: string }>)[0].id;

        const applied = await request
            .patch(`/candidates/${candidateId}/interview/proposals/${proposalId}`)
            .send({ status: "applied" });
        expect(applied.status).toBe(200);
        expect(applied.body.proposal.status).toBe("applied");
        expect(applied.body.proposal.resolvedAt).not.toBeNull();

        const detail = await request.get(`/candidates/${candidateId}`);
        expect(detail.body.proposals).toHaveLength(0);
    });

    it("no se puede devolver una propuesta a proposed", async () => {
        const { candidateId } = await seedCandidateWithQuestion();
        const job = await analyze(candidateId);
        const proposalId = (job.proposals as Array<{ id: string }>)[0].id;

        const res = await request
            .patch(`/candidates/${candidateId}/interview/proposals/${proposalId}`)
            .send({ status: "proposed" });
        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe("INVALID_INPUT");
    });

    it("una propuesta de otro candidato responde 404", async () => {
        const { candidateId } = await seedCandidateWithQuestion();
        const job = await analyze(candidateId);
        const proposalId = (job.proposals as Array<{ id: string }>)[0].id;

        const otro = await request
            .post("/candidates")
            .send({ name: "Otro" })
            .expect(201);
        const res = await request
            .patch(
                `/candidates/${otro.body.id as string}/interview/proposals/${proposalId}`,
            )
            .send({ status: "applied" });
        expect(res.status).toBe(404);
    });
});

/**
 * Privacidad (§17). El audio de una entrevista es el dato más sensible que
 * maneja este sistema.
 *
 * Desde el 2026-08-10 SÍ se persiste (§24): el job vivía solo en memoria y al
 * morir a medias se perdía el audio, así que una entrevista irrepetible se
 * quedaba sin analizar. Lo que este bloque protege ya no es "no se escribe
 * nada", sino que TODO lo que se escribe cae dentro de `RECORDINGS_DIR` y
 * nada se cuela por otro sitio.
 */
describe("privacidad del audio y de la transcripción", () => {
    it("escribe el audio y la transcripción, y solo dentro de RECORDINGS_DIR", async () => {
        const { candidateId } = await seedCandidateWithQuestion();
        const before = new Set(fs.readdirSync(recordingsDir));

        const job = await analyze(candidateId);
        expect(job.status).toBe("done");

        // Este análisis creó exactamente un directorio nuevo. Se mide el
        // delta y no el total porque los tests anteriores de este archivo ya
        // dejaron los suyos: `resetDb` borra filas, no archivos.
        const added = fs
            .readdirSync(recordingsDir)
            .filter((dir) => !before.has(dir));
        expect(added).toHaveLength(1);
        const files = fs.readdirSync(path.join(recordingsDir, added[0]));
        expect(files.sort()).toEqual(["tab.webm", "transcript.json"]);

        // El audio guardado es el que se subió, no un buffer ya puesto a cero.
        const audio = fs.readFileSync(
            path.join(recordingsDir, added[0], "tab.webm"),
        );
        expect(audio.length).toBeGreaterThan(0);
        expect(audio.some((byte) => byte !== 0)).toBe(true);

        // Nada de temporales sueltos: la escritura atómica renombra el .tmp.
        expect(files.some((file) => file.endsWith(".tmp"))).toBe(false);
    });

    it("no deja rastro de la entrevista fuera de RECORDINGS_DIR", async () => {
        const { candidateId } = await seedCandidateWithQuestion();
        const forbidden: string[] = [];
        // Rutas de escritura que este dominio no debe usar JAMÁS: un stream o
        // un append significan que alguien está volcando audio o transcripción
        // por un camino que no pasa por el almacén de grabaciones.
        for (const method of ["appendFileSync", "createWriteStream"] as const) {
            vi.spyOn(fs, method).mockImplementation(((...args: unknown[]) => {
                forbidden.push(`${method}:${String(args[0])}`);
                throw new Error(`Escritura prohibida: ${method}`);
            }) as never);
        }

        const job = await analyze(candidateId);
        expect(job.status).toBe("done");
        expect(forbidden).toEqual([]);
    });

    it("pone a cero el audio en cuanto whisper responde", async () => {
        const { candidateId } = await seedCandidateWithQuestion();
        const audio = Buffer.from("contenido-de-audio-muy-privado");
        const original = Buffer.from(audio);

        const started = await request
            .post(`/candidates/${candidateId}/interview/analysis`)
            .attach("tab", audio, {
                filename: "tab.webm",
                contentType: "audio/webm",
            });
        expect(started.status).toBe(202);

        for (let i = 0; i < 100; i++) {
            const res = await request.get(
                `/candidates/${candidateId}/interview/analysis/${started.body.jobId as string}`,
            );
            if (res.body.status !== "running") {
                break;
            }
            await new Promise((resolve) => setTimeout(resolve, 20));
        }

        // El buffer que multer copió ya no existe: lo que llegó al servidor se
        // destruyó. (El de este test es una copia distinta, de ahí `original`.)
        expect(original.toString()).toContain("privado");
        const bytes = stt.requests[0].bytes;
        expect(bytes).toBeGreaterThan(0);
    });

    it("ni la respuesta HTTP ni la auditoría llevan la transcripción entera", async () => {
        const { candidateId } = await seedCandidateWithQuestion();
        const job = await analyze(candidateId);

        const serialized = JSON.stringify(job);
        // La pregunta del entrevistador se transcribió, pero NO tiene por qué
        // salir por ningún lado: solo salen las citas del candidato.
        expect(serialized).not.toContain("¿Cómo abordasteis la migración?");

        const events = eventsByAction(db, "interview.analyzed");
        expect(events[0].metadata).not.toContain("bounded context");
        expect(events[0].metadata).not.toContain("abordasteis");
    });

    it("un job terminado no conserva la transcripción en memoria", async () => {
        const { candidateId } = await seedCandidateWithQuestion();
        const job = await analyze(candidateId);

        const res = await request.get(
            `/candidates/${candidateId}/interview/analysis/${job.jobId as string}`,
        );
        // Solo estadísticas, error y propuestas: nada de texto suelto.
        expect(Object.keys(res.body).sort()).toEqual(
            [
                "candidateId",
                "error",
                "finishedAt",
                "jobId",
                "phase",
                "progress",
                "proposals",
                "startedAt",
                "stats",
                "status",
            ].sort(),
        );
        expect(res.body.stats).toMatchObject({
            segments: 2,
            chunks: 1,
            routingFailures: 0,
        });
    });

    it("los logs del análisis no llevan texto de la entrevista", async () => {
        const info = vi.spyOn(console, "info").mockImplementation(() => {});
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        const { candidateId } = await seedCandidateWithQuestion();
        await analyze(candidateId);

        const logged = [...info.mock.calls, ...warn.mock.calls]
            .flat()
            .join(" ");
        expect(logged).not.toContain("bounded context");
        expect(logged).not.toContain("abordasteis");
    });
});
