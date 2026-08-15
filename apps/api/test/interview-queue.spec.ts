import { mkdtempSync, rmSync } from "node:fs";
import { Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { createModule, interfaces } from "@expressots/core";
import supertest from "supertest";
import {
    afterAll,
    afterEach,
    beforeAll,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from "vitest";
import { App } from "../src/app";
import { Database, DB } from "../src/db/database";
import { AppEnv, ENV, loadEnv } from "../src/env";
import { InterviewJobRegistry } from "../src/interview/job-registry";
import {
    INTERVIEW_RATE_KEY,
    INTERVIEW_REANALYSIS_RATE_KEY,
} from "../src/interview/start-analysis.usecase";
import { RateLimiter } from "../src/security/rate-limit";
import { AuditRepository } from "../src/shared/audit";
import { newId } from "../src/shared/ids";
import { MAX_QUEUED_INTERVIEW_ANALYSES } from "../src/shared/limits";
import { chatCompletion, MockLlm, Responder, startMockLlm } from "./ai-helpers";
import { resetDb } from "./app-helpers";
import { createTestDb } from "./helpers";
import {
    MockStt,
    MockSttResponse,
    SttResponder,
    startMockStt,
    verboseJson,
} from "./stt-helpers";

/**
 * Cola de análisis de entrevista y reparto del rate limit (§24, 2026-08-15).
 *
 * Lo que se fija aquí: sigue corriendo UN análisis a la vez, pero el segundo
 * ya no se rechaza (espera con posición visible y se puede cancelar), el
 * estado de cada grabación distingue "en cola" / "corriendo" / "interrumpido",
 * y el cupo caro (transcribir) no se gasta en lo que no transcribe.
 */

let db: Database;
let request: ReturnType<typeof supertest>;
let server: Server;
let llm: MockLlm;
let stt: MockStt;
let recordingsDir: string;
let registry: InterviewJobRegistry;
const rateLimiter = new RateLimiter();
let llmResponder: Responder;
let sttResponder: SttResponder;

const DICHO =
    "Partimos por bounded context separando pagos de catálogo, porque los ciclos de despliegue no tenían nada que ver, y descartamos sacar primero la capa de datos; medimos la latencia p99 con CloudWatch antes y después y bajó de ochocientos a doscientos diez milisegundos";

/**
 * Compuerta para dejar a whisper "trabajando" el tiempo que haga falta: el
 * job que la espera se queda en `running` y todo lo que llegue detrás va a
 * la cola.
 */
function gate(): { open: () => void; wait: Promise<void> } {
    let open!: () => void;
    const wait = new Promise<void>((resolve) => {
        open = resolve;
    });
    return { open, wait };
}

beforeAll(async () => {
    llm = await startMockLlm((req, index) => llmResponder(req, index));
    stt = await startMockStt((req, index) => sttResponder(req, index));
    db = createTestDb();
    recordingsDir = mkdtempSync(path.join(os.tmpdir(), "queue-spec-"));
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
    registry = app.diContainer.Container.get(InterviewJobRegistry);
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
    llmResponder = (req) =>
        req.body.messages[0].content.includes("Preguntas preparadas")
            ? chatCompletion({
                  matches: [
                      {
                          question_ref: "P1",
                          relevance: "central",
                          quote: DICHO.slice(0, 200),
                      },
                  ],
              })
            : chatCompletion({
                  coverage: "abordado_demostrado",
                  proposed_score: 8,
                  proposed_notes: "Explica la partición y la valida.",
                  evidence: [{ quote: DICHO }],
                  confidence: 0.9,
              });
});

afterEach(async () => {
    vi.restoreAllMocks();
    // Que ningún job de un test se quede vivo para el siguiente.
    for (let i = 0; i < 200 && registry.active(); i++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
});

async function seedCandidate(name: string): Promise<string> {
    const created = await request.post("/candidates").send({ name }).expect(201);
    const candidateId = created.body.id as string;
    db.prepare(
        `INSERT INTO interview_question
             (id, candidate_id, criterion, dimension, question, ideal_answer,
              positive_signals, warning_signals, scoring_guidance)
         VALUES (?, ?, 'depth', 'profundidad_vs_exposicion',
                 '¿Cómo particionaste el dominio?', 'Nombra una decisión concreta',
                 '["Cita una métrica"]', '["Habla en genérico"]',
                 '1: sin decisión. 3: sin datos. 5: con validación.')`,
    ).run(newId(), candidateId);
    return candidateId;
}

async function seedProcessWith(...names: string[]): Promise<string[]> {
    await request
        .post("/process")
        .send({ roleTitle: "Backend Serverless" })
        .expect(201);
    const ids: string[] = [];
    for (const name of names) {
        ids.push(await seedCandidate(name));
    }
    return ids;
}

function upload(candidateId: string) {
    return request
        .post(`/candidates/${candidateId}/interview/analysis`)
        .attach("tab", Buffer.from("audio-falso"), {
            filename: "tab.webm",
            contentType: "audio/webm",
        });
}

async function getJob(
    candidateId: string,
    jobId: string,
): Promise<Record<string, unknown>> {
    const res = await request.get(
        `/candidates/${candidateId}/interview/analysis/${jobId}`,
    );
    expect(res.status).toBe(200);
    return res.body as Record<string, unknown>;
}

async function waitForJob(
    candidateId: string,
    jobId: string,
): Promise<Record<string, unknown>> {
    for (let i = 0; i < 200; i++) {
        const job = await getJob(candidateId, jobId);
        if (job.status !== "running" && job.status !== "queued") {
            return job;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("El análisis no terminó a tiempo");
}

async function recordingsOf(candidateId: string) {
    const res = await request
        .get(`/candidates/${candidateId}/interview/recordings`)
        .expect(200);
    return res.body.recordings as Array<Record<string, unknown>>;
}

describe("cola de análisis", () => {
    it("el segundo análisis espera en cola con posición y arranca al acabar el primero", async () => {
        const [ana, luis] = await seedProcessWith("Ana", "Luis");
        const whisper = gate();
        const slow = sttResponder;
        sttResponder = async (req, index): Promise<MockSttResponse> => {
            await whisper.wait;
            return slow(req, index);
        };

        const first = await upload(ana).expect(202);
        expect(first.body.status).toBe("running");
        expect(first.body.queuePosition).toBeNull();

        const second = await upload(luis).expect(202);
        expect(second.body.status).toBe("queued");
        expect(second.body.queuePosition).toBe(1);
        expect(second.body.recordingId).toBeTypeOf("string");

        // Mientras espera no ha tocado ni whisper ni el modelo por él.
        expect(stt.requests).toHaveLength(1);
        const queued = await getJob(luis, second.body.jobId as string);
        expect(queued.status).toBe("queued");
        expect(queued.queuePosition).toBe(1);

        // Y su grabación lo dice, con el job al que engancharse.
        const [luisRec] = await recordingsOf(luis);
        expect(luisRec.lastStatus).toBe("queued");
        expect(luisRec.activeJobId).toBe(second.body.jobId);
        const [anaRec] = await recordingsOf(ana);
        expect(anaRec.lastStatus).toBe("running");
        expect(anaRec.activeJobId).toBe(first.body.jobId);

        whisper.open();
        const done1 = await waitForJob(ana, first.body.jobId as string);
        const done2 = await waitForJob(luis, second.body.jobId as string);
        expect(done1.status).toBe("done");
        expect(done2.status).toBe("done");
        expect(stt.requests).toHaveLength(2);
        expect((await recordingsOf(luis))[0].lastStatus).toBe("done");
    });

    it("el mismo candidato no puede tener dos análisis vivos", async () => {
        const [ana] = await seedProcessWith("Ana");
        const whisper = gate();
        const slow = sttResponder;
        sttResponder = async (req, index): Promise<MockSttResponse> => {
            await whisper.wait;
            return slow(req, index);
        };
        const first = await upload(ana).expect(202);

        const again = await upload(ana);
        expect(again.status).toBe(422);
        expect(again.body.error.code).toBe("LIMIT_EXCEEDED");
        expect(again.body.error.message).toContain("en curso o en cola");
        // El rechazo no dejó una segunda grabación huérfana.
        expect(await recordingsOf(ana)).toHaveLength(1);

        whisper.open();
        await waitForJob(ana, first.body.jobId as string);
    });

    it(`con ${MAX_QUEUED_INTERVIEW_ANALYSES} esperando, el siguiente se rechaza sin gastar cupo`, async () => {
        const names = Array.from(
            { length: MAX_QUEUED_INTERVIEW_ANALYSES + 2 },
            (_, i) => `Cand ${i}`,
        );
        const ids = await seedProcessWith(...names);
        const whisper = gate();
        const slow = sttResponder;
        sttResponder = async (req, index): Promise<MockSttResponse> => {
            await whisper.wait;
            return slow(req, index);
        };
        // Cupo de sobra: lo que se prueba es la cola, no el rate limit.
        const check = vi.spyOn(rateLimiter, "check").mockImplementation(() => {});

        const started: Array<{ candidateId: string; jobId: string }> = [];
        for (const id of ids.slice(0, MAX_QUEUED_INTERVIEW_ANALYSES + 1)) {
            const res = await upload(id).expect(202);
            started.push({ candidateId: id, jobId: res.body.jobId as string });
        }
        const checksBefore = check.mock.calls.length;
        const overflow = await upload(ids[ids.length - 1]);
        expect(overflow.status).toBe(422);
        expect(overflow.body.error.message).toContain("esperando");
        // Rechazado ANTES del rate limit: no consumió nada.
        expect(check.mock.calls.length).toBe(checksBefore);

        whisper.open();
        for (const job of started) {
            await waitForJob(job.candidateId, job.jobId);
        }
    });

    it("cancelar un job en cola lo saca sin ejecutarlo y devuelve el cupo", async () => {
        const [ana, luis] = await seedProcessWith("Ana", "Luis");
        const whisper = gate();
        const slow = sttResponder;
        sttResponder = async (req, index): Promise<MockSttResponse> => {
            await whisper.wait;
            return slow(req, index);
        };
        const refund = vi.spyOn(rateLimiter, "refund");

        const first = await upload(ana).expect(202);
        const second = await upload(luis).expect(202);
        expect(second.body.status).toBe("queued");

        const cancelled = await request
            .delete(
                `/candidates/${luis}/interview/analysis/${second.body.jobId as string}`,
            )
            .expect(200);
        expect(cancelled.body.status).toBe("cancelled");
        expect(refund).toHaveBeenCalledWith(INTERVIEW_RATE_KEY);
        expect((await recordingsOf(luis))[0].lastStatus).toBe("cancelled");

        whisper.open();
        await waitForJob(ana, first.body.jobId as string);
        // Nunca llegó a transcribir: solo la pista de Ana pasó por whisper.
        expect(stt.requests).toHaveLength(1);
    });

    it("cancelar uno que ya corre NO devuelve el cupo", async () => {
        const [ana] = await seedProcessWith("Ana");
        const whisper = gate();
        const slow = sttResponder;
        sttResponder = async (req, index): Promise<MockSttResponse> => {
            await whisper.wait;
            return slow(req, index);
        };
        const refund = vi.spyOn(rateLimiter, "refund");
        const first = await upload(ana).expect(202);
        await request
            .delete(
                `/candidates/${ana}/interview/analysis/${first.body.jobId as string}`,
            )
            .expect(200);
        expect(refund).not.toHaveBeenCalled();
        whisper.open();
        await waitForJob(ana, first.body.jobId as string);
    });
});

describe("reparto del rate limit", () => {
    it("reanalizar desde la transcripción guardada consume el cupo barato", async () => {
        const [ana] = await seedProcessWith("Ana");
        const check = vi.spyOn(rateLimiter, "check");
        const first = await upload(ana).expect(202);
        await waitForJob(ana, first.body.jobId as string);
        expect(check.mock.calls.map((call) => call[0])).toEqual([
            INTERVIEW_RATE_KEY,
        ]);

        const resumed = await request
            .post(
                `/candidates/${ana}/interview/analysis/from/${first.body.recordingId as string}`,
            )
            .send({})
            .expect(202);
        await waitForJob(ana, resumed.body.jobId as string);
        expect(check.mock.calls.map((call) => call[0])).toEqual([
            INTERVIEW_RATE_KEY,
            INTERVIEW_REANALYSIS_RATE_KEY,
        ]);
        // Y de verdad no volvió a transcribir.
        expect(stt.requests).toHaveLength(1);
    });

    it("sin transcripción guardada, reanalizar vuelve a ir contra el cupo caro", async () => {
        const [ana] = await seedProcessWith("Ana");
        const check = vi.spyOn(rateLimiter, "check");
        const first = await upload(ana).expect(202);
        await waitForJob(ana, first.body.jobId as string);
        db.prepare(
            "UPDATE interview_recording SET transcript_at = NULL WHERE id = ?",
        ).run(first.body.recordingId);
        rmSync(
            path.join(recordingsDir, first.body.recordingId as string, "transcript.json"),
            { force: true },
        );

        const resumed = await request
            .post(
                `/candidates/${ana}/interview/analysis/from/${first.body.recordingId as string}`,
            )
            .send({})
            .expect(202);
        await waitForJob(ana, resumed.body.jobId as string);
        expect(check.mock.calls.at(-1)?.[0]).toBe(INTERVIEW_RATE_KEY);
        expect(stt.requests).toHaveLength(2);
    });

    it("si whisper no está, el cupo se devuelve para poder reintentar", async () => {
        const [ana] = await seedProcessWith("Ana");
        sttResponder = () => ({ status: 503, body: { error: "down" } });
        const refund = vi.spyOn(rateLimiter, "refund");

        const first = await upload(ana).expect(202);
        const job = await waitForJob(ana, first.body.jobId as string);
        expect(job.status).toBe("failed");
        expect((job.error as { code: string }).code).toBe("STT_UNAVAILABLE");
        expect(refund).toHaveBeenCalledWith(INTERVIEW_RATE_KEY);
        expect((await recordingsOf(ana))[0].lastStatus).toBe("failed");
    });
});

describe("estado de la grabación", () => {
    it("una fila en running sin job vivo se enseña como interrumpida", async () => {
        const [ana] = await seedProcessWith("Ana");
        const first = await upload(ana).expect(202);
        await waitForJob(ana, first.body.jobId as string);

        // Simula un reinicio del backend a mitad: la fila dice running y el
        // job ya no existe en memoria.
        db.prepare(
            "UPDATE interview_recording SET last_status = 'running', last_run_id = ? WHERE id = ?",
        ).run(newId(), first.body.recordingId);

        const [rec] = await recordingsOf(ana);
        expect(rec.lastStatus).toBe("interrupted");
        expect(rec.activeJobId).toBeNull();
    });

    it("un job en cola relee las preguntas al arrancar: si ya se puntuaron, no propone nada", async () => {
        const [ana, luis] = await seedProcessWith("Ana", "Luis");
        const whisper = gate();
        const slow = sttResponder;
        sttResponder = async (req, index): Promise<MockSttResponse> => {
            await whisper.wait;
            return slow(req, index);
        };
        const first = await upload(ana).expect(202);
        const second = await upload(luis).expect(202);
        expect(second.body.status).toBe("queued");

        // Mientras Luis espera, el evaluador puntúa a mano su única pregunta.
        db.prepare(
            "UPDATE interview_question SET answer_score = 7 WHERE candidate_id = ?",
        ).run(luis);

        whisper.open();
        await waitForJob(ana, first.body.jobId as string);
        const job = await waitForJob(luis, second.body.jobId as string);
        expect(job.status).toBe("failed");
        expect((job.error as { code: string }).code).toBe("LIMIT_EXCEEDED");
        expect(job.proposals).toEqual([]);
        // No gastó ni una llamada por él: whisper solo vio la pista de Ana.
        expect(stt.requests).toHaveLength(1);
    });
});
