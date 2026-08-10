import fs, { mkdtempSync, rmSync } from "node:fs";
import { Server } from "node:http";
import os from "node:os";
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
} from "vitest";
import { App } from "../src/app";
import { Database, DB } from "../src/db/database";
import { AppEnv, ENV, loadEnv } from "../src/env";
import {
    pruneOrphanRecordings,
    readTranscript,
    saveTranscript,
} from "../src/interview/recording-store";
import { RateLimiter } from "../src/security/rate-limit";
import { AuditRepository } from "../src/shared/audit";
import { MAX_RECORDINGS_PER_CANDIDATE } from "../src/shared/limits";
import { newId } from "../src/shared/ids";
import { chatCompletion, MockLlm, Responder, startMockLlm } from "./ai-helpers";
import { resetDb } from "./app-helpers";
import { createTestDb } from "./helpers";
import { MockStt, SttResponder, startMockStt, verboseJson } from "./stt-helpers";

/**
 * Grabaciones conservadas y reanálisis (§24, 2026-08-10).
 *
 * Lo que se prueba aquí es la razón de ser del cambio: que un análisis que se
 * cae se pueda REINTENTAR sin volver a subir el audio, y que reintentarlo no
 * vuelva a pasar por whisper si la transcripción ya estaba hecha.
 */

let db: Database;
let request: ReturnType<typeof supertest>;
let server: Server;
let llm: MockLlm;
let stt: MockStt;
let recordingsDir: string;
const rateLimiter = new RateLimiter();
let llmResponder: Responder;
let sttResponder: SttResponder;

const DICHO =
    "Partimos por bounded context separando pagos de catálogo, porque los ciclos de despliegue no tenían nada que ver, y descartamos sacar primero la capa de datos; medimos la latencia p99 con CloudWatch antes y después y bajó de ochocientos a doscientos diez milisegundos";

beforeAll(async () => {
    llm = await startMockLlm((req, index) => llmResponder(req, index));
    stt = await startMockStt((req, index) => sttResponder(req, index));
    db = createTestDb();
    recordingsDir = mkdtempSync(path.join(os.tmpdir(), "recordings-spec-"));
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

    // Mismo responder que interview-analysis.spec: enrutado al P1 y una
    // evaluación con cita real, para que el verificador no la degrade.
    llmResponder = (req) => {
        const prompt = req.body.messages[0].content;
        if (prompt.includes("Preguntas preparadas")) {
            return chatCompletion({
                matches: [
                    {
                        question_ref: "P1",
                        relevance: "central",
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

async function seedCandidateWithQuestion(): Promise<string> {
    await request
        .post("/process")
        .send({ roleTitle: "Backend Serverless" })
        .expect(201);
    const created = await request
        .post("/candidates")
        .send({ name: "Ana Ejemplo" })
        .expect(201);
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

/** Espera a que el job deje de estar en curso y devuelve su estado final. */
async function waitForJob(
    candidateId: string,
    jobId: string,
): Promise<Record<string, unknown>> {
    for (let i = 0; i < 100; i++) {
        const res = await request.get(
            `/candidates/${candidateId}/interview/analysis/${jobId}`,
        );
        if (res.body.status !== "running") {
            return res.body as Record<string, unknown>;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("El análisis no terminó a tiempo");
}

async function analyze(
    candidateId: string,
): Promise<{ jobId: string; recordingId: string }> {
    const started = await request
        .post(`/candidates/${candidateId}/interview/analysis`)
        .attach("tab", Buffer.from("audio-falso-de-entrevista"), {
            filename: "tab.webm",
            contentType: "audio/webm",
        });
    expect(started.status).toBe(202);
    await waitForJob(candidateId, started.body.jobId as string);
    return {
        jobId: started.body.jobId as string,
        recordingId: started.body.recordingId as string,
    };
}

describe("GET /candidates/:id/interview/recordings", () => {
    it("lista la grabación con su duración, tamaño y estado", async () => {
        const candidateId = await seedCandidateWithQuestion();
        const { recordingId } = await analyze(candidateId);

        const res = await request.get(
            `/candidates/${candidateId}/interview/recordings`,
        );
        expect(res.status).toBe(200);
        expect(res.body.recordings).toHaveLength(1);

        const recording = res.body.recordings[0];
        expect(recording.id).toBe(recordingId);
        expect(recording.hasTranscript).toBe(true);
        expect(recording.lastStatus).toBe("done");
        expect(recording.durationSec).toBe(38);
        expect(recording.bytes).toBeGreaterThan(0);
        expect(recording.tracks).toEqual([
            { label: "tab", speaker: "candidato", bytes: expect.any(Number) },
        ]);
    });

    it("no expone rutas de disco", async () => {
        const candidateId = await seedCandidateWithQuestion();
        await analyze(candidateId);

        const res = await request.get(
            `/candidates/${candidateId}/interview/recordings`,
        );
        // Ni el directorio de grabaciones ni ningún nombre de archivo salen
        // por la API: el audio no se sirve desde ninguna ruta (§17).
        expect(JSON.stringify(res.body)).not.toContain(recordingsDir);
        expect(JSON.stringify(res.body)).not.toContain(".webm");
    });
});

describe("POST /candidates/:id/interview/analysis/from/:recordingId", () => {
    it("reanaliza sin volver a transcribir cuando ya hay transcripción", async () => {
        const candidateId = await seedCandidateWithQuestion();
        const { recordingId } = await analyze(candidateId);
        expect(stt.requests).toHaveLength(1);

        stt.requests.length = 0;
        const resumed = await request
            .post(
                `/candidates/${candidateId}/interview/analysis/from/${recordingId}`,
            )
            .send({ includeAnswered: true });
        expect(resumed.status).toBe(202);
        expect(resumed.body.recordingId).toBe(recordingId);

        const job = await waitForJob(candidateId, resumed.body.jobId as string);
        expect(job.status).toBe("done");
        // Lo que motivó todo esto: el reintento NO vuelve a pasar por whisper.
        expect(stt.requests).toHaveLength(0);
        expect((job.proposals as unknown[]).length).toBeGreaterThan(0);
    });

    it("vuelve a transcribir si el intento anterior murió antes de acabarla", async () => {
        const candidateId = await seedCandidateWithQuestion();
        const { recordingId } = await analyze(candidateId);

        // Simula el fallo real: el job se cayó durante la transcripción, así
        // que el audio está en disco pero transcript.json no llegó a existir.
        rmSync(path.join(recordingsDir, recordingId, "transcript.json"));
        db.prepare(
            "UPDATE interview_recording SET transcript_at = NULL, last_status = 'failed' WHERE id = ?",
        ).run(recordingId);

        stt.requests.length = 0;
        const resumed = await request
            .post(
                `/candidates/${candidateId}/interview/analysis/from/${recordingId}`,
            )
            .send({ includeAnswered: true });
        expect(resumed.status).toBe(202);

        const job = await waitForJob(candidateId, resumed.body.jobId as string);
        expect(job.status).toBe("done");
        // Relee el audio del disco y retranscribe: sin él no habría nada.
        expect(stt.requests).toHaveLength(1);
        expect(stt.requests[0].bytes).toBeGreaterThan(0);
    });

    it("404 si la grabación es de otro candidato", async () => {
        const candidateId = await seedCandidateWithQuestion();
        const { recordingId } = await analyze(candidateId);
        const other = await request
            .post("/candidates")
            .send({ name: "Otro Candidato" })
            .expect(201);

        const res = await request
            .post(
                `/candidates/${other.body.id as string}/interview/analysis/from/${recordingId}`,
            )
            .send({});
        expect(res.status).toBe(404);
    });
});

describe("DELETE /candidates/:id/interview/recordings/:recordingId", () => {
    it("borra los archivos y la fila", async () => {
        const candidateId = await seedCandidateWithQuestion();
        const { recordingId } = await analyze(candidateId);
        expect(fs.existsSync(path.join(recordingsDir, recordingId))).toBe(true);

        const res = await request.delete(
            `/candidates/${candidateId}/interview/recordings/${recordingId}`,
        );
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ id: recordingId, deleted: true });

        // El audio desaparece del disco, no solo de la base.
        expect(fs.existsSync(path.join(recordingsDir, recordingId))).toBe(false);
        const list = await request.get(
            `/candidates/${candidateId}/interview/recordings`,
        );
        expect(list.body.recordings).toHaveLength(0);
    });

    it("purgar el proceso borra también el audio del disco", async () => {
        const candidateId = await seedCandidateWithQuestion();
        const { recordingId } = await analyze(candidateId);

        const res = await request
            .delete("/process")
            .send({ confirmDelete: true });
        expect(res.status).toBe(200);
        expect(res.body.recordings).toBe(1);
        expect(fs.existsSync(path.join(recordingsDir, recordingId))).toBe(false);
    });

    it(`rechaza pasar de ${MAX_RECORDINGS_PER_CANDIDATE} grabaciones por candidato`, async () => {
        const candidateId = await seedCandidateWithQuestion();
        for (let i = 0; i < MAX_RECORDINGS_PER_CANDIDATE; i++) {
            const started = await request
                .post(`/candidates/${candidateId}/interview/analysis`)
                .field("meta", JSON.stringify({ includeAnswered: true }))
                .attach("tab", Buffer.from(`audio-${i}`), {
                    filename: "tab.webm",
                    contentType: "audio/webm",
                });
            expect(started.status).toBe(202);
            await waitForJob(candidateId, started.body.jobId as string);
        }

        const extra = await request
            .post(`/candidates/${candidateId}/interview/analysis`)
            .field("meta", JSON.stringify({ includeAnswered: true }))
            .attach("tab", Buffer.from("uno-de-mas"), {
                filename: "tab.webm",
                contentType: "audio/webm",
            });
        expect(extra.status).toBe(422);
        expect(extra.body.error.code).toBe("LIMIT_EXCEEDED");
    });
});

describe("almacén de grabaciones", () => {
    it("una transcripción corrupta se retranscribe en vez de romper", () => {
        const id = newId();
        saveTranscript(recordingsDir, id, {
            durationSec: 10,
            segments: [
                { startSec: 0, endSec: 5, text: "hola", speaker: "candidato" },
            ],
        });
        expect(readTranscript(recordingsDir, id)).not.toBeNull();

        fs.writeFileSync(
            path.join(recordingsDir, id, "transcript.json"),
            "{ esto no es json",
        );
        // `null` significa "vuelve a transcribir", no "revienta".
        expect(readTranscript(recordingsDir, id)).toBeNull();
        rmSync(path.join(recordingsDir, id), { recursive: true, force: true });
    });

    it("el barrido borra las huérfanas y respeta las conocidas", () => {
        const known = newId();
        const orphan = newId();
        for (const id of [known, orphan]) {
            saveTranscript(recordingsDir, id, { durationSec: 1, segments: [] });
        }
        // Un directorio ajeno que no es una grabación: no debe tocarse nunca.
        const foreign = path.join(recordingsDir, "no-soy-una-grabacion");
        fs.mkdirSync(foreign, { recursive: true });

        const removed = pruneOrphanRecordings(recordingsDir, new Set([known]));

        expect(removed).toContain(orphan);
        expect(removed).not.toContain(known);
        expect(fs.existsSync(path.join(recordingsDir, known))).toBe(true);
        expect(fs.existsSync(path.join(recordingsDir, orphan))).toBe(false);
        expect(fs.existsSync(foreign)).toBe(true);

        rmSync(foreign, { recursive: true, force: true });
        rmSync(path.join(recordingsDir, known), {
            recursive: true,
            force: true,
        });
    });
});
