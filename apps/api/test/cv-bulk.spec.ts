import { readFileSync } from "node:fs";
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
} from "vitest";
import {
    ensureFixtures,
    FIXTURES_DIR,
    SENTINEL_PERSONAL_DATA,
    TXT_MARKER,
} from "../scripts/generate-fixtures";
import { App } from "../src/app";
import { BULK_LLM_RETRY } from "../src/cv/bulk-import.usecase";
import {
    candidateNameFromFilename,
    dedupeNames,
} from "../src/cv/candidate-name";
import { CvBulkImportResponseDTO } from "../src/cv/cv.dto";
import { CV_EXTRACT_RATE_KEY } from "../src/cv/extract-cv.usecase";
import { Database, DB } from "../src/db/database";
import { AppEnv, ENV, loadEnv } from "../src/env";
import { RateLimiter } from "../src/security/rate-limit";
import { AuditRepository } from "../src/shared/audit";
import { AppError } from "../src/shared/errors";
import { newId } from "../src/shared/ids";
import {
    MAX_BULK_CV_FILES,
    MAX_CANDIDATES_PER_PROCESS,
    MAX_CV_MB,
    RATE_LIMITS_PER_HOUR,
} from "../src/shared/limits";
import { eventsByAction, resetDb } from "./app-helpers";
import {
    chatCompletion,
    MockLlm,
    MockResponse,
    RecordedRequest,
    startMockLlm,
} from "./ai-helpers";
import { createTestDb } from "./helpers";

/**
 * Carga masiva de CVs (§16, 2026-08-15): POST /candidates/cv/bulk +
 * GET/DELETE /candidates/cv/bulk/:jobId sobre la app real, DB :memory: y
 * mock HTTP de llama.cpp. El job corre en segundo plano: los tests esperan
 * con polling igual que hará la UI.
 */

function validSummary() {
    return {
        professional_summary: "Perfil backend.",
        evidence: {
            adaptability: [{ text: "Migró de Java a Node.", type: "explicit" }],
            fundamentals: [],
            depth: [],
            production: [],
            stack: [],
        },
        technology_transitions: [],
        doubts_for_interview: [],
        risks: [],
    };
}

type Responder = (
    request: RecordedRequest,
    index: number,
) => MockResponse | Promise<MockResponse>;

describe("candidateNameFromFilename", () => {
    it.each([
        ["cv_ana-perez.pdf", "Ana Perez"],
        ["CV Ana Pérez 2026.docx", "Ana Pérez"],
        ["Curriculum Vitae - Juan de la Torre (1).pdf", "Juan de la Torre"],
        ["hoja_de_vida_MARIA_LOPEZ.txt", "Maria Lopez"],
        ["McArthur_Resume_v2.pdf", "McArthur"],
        ["/tmp/uploads/lucia.garcia.final.pdf", "Lucia Garcia"],
    ])("%s → %s", (filename, expected) => {
        expect(candidateNameFromFilename(filename, 0)).toBe(expected);
    });

    it("sin nada aprovechable cae a 'Candidato N' con la posición del lote", () => {
        expect(candidateNameFromFilename("cv.pdf", 0)).toBe("Candidato 1");
        expect(candidateNameFromFilename("2026-01.pdf", 4)).toBe("Candidato 5");
        expect(candidateNameFromFilename(undefined as never, 1)).toBe(
            "Candidato 2",
        );
    });

    it("recorta a 200 caracteres", () => {
        const long = "a".repeat(300) + ".pdf";
        expect(candidateNameFromFilename(long, 0)).toHaveLength(200);
    });

    it("dedupeNames numera los repetidos sin distinguir mayúsculas", () => {
        expect(dedupeNames(["Ana", "ana", "Luis", "ANA"])).toEqual([
            "Ana",
            "ana (2)",
            "Luis",
            "ANA (3)",
        ]);
    });
});

describe("RateLimiter.checkMany", () => {
    it("reserva N usos de golpe o no reserva ninguno", () => {
        const limiter = new RateLimiter();
        limiter.checkMany("k", 5, 3);
        expect(() => limiter.checkMany("k", 5, 3)).toThrow(AppError);
        // El intento fallido no consumió nada: aún caben 2.
        limiter.checkMany("k", 5, 2);
        expect(() => limiter.check("k", 5)).toThrow(AppError);
    });
});

describe("POST /candidates/cv/bulk", () => {
    let db: Database;
    let request: ReturnType<typeof supertest>;
    let server: Server;
    let mock: MockLlm;
    const rateLimiter = new RateLimiter();
    let responder: Responder;

    beforeAll(async () => {
        await ensureFixtures();
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
        // Esperas al modelo caído en milisegundos, no en medio minuto.
        BULK_LLM_RETRY.delayMs = 20;
        BULK_LLM_RETRY.maxWaits = 2;
    });

    afterAll(async () => {
        await new Promise<void>((resolve, reject) => {
            server.close((error) => (error ? reject(error) : resolve()));
        });
        await mock.close();
    });

    beforeEach(async () => {
        // Un lote anterior aún vivo bloquearía el siguiente: se espera.
        await settleActiveJob();
        resetDb(db);
        rateLimiter.reset();
        mock.requests.length = 0;
        responder = () => chatCompletion(validSummary());
    });

    let lastJobId: string | null = null;
    async function settleActiveJob(): Promise<void> {
        if (lastJobId) {
            await waitForJob(lastJobId).catch(() => undefined);
            lastJobId = null;
        }
    }

    async function createProcess(): Promise<string> {
        const res = await request
            .post("/process")
            .send({ roleTitle: "Backend Serverless" });
        expect(res.status).toBe(201);
        return res.body.id as string;
    }

    function fixture(name: string): Buffer {
        return readFileSync(path.join(FIXTURES_DIR, name));
    }

    interface Attachment {
        buffer: Buffer;
        filename: string;
        contentType?: string;
    }

    function bulk(files: Attachment[], names?: Array<string | null>) {
        let req = request.post("/candidates/cv/bulk");
        if (names !== undefined) {
            req = req.field("names", JSON.stringify(names));
        }
        for (const file of files) {
            req = file.contentType
                ? req.attach("files", file.buffer, {
                      filename: file.filename,
                      contentType: file.contentType,
                  })
                : req.attach("files", file.buffer, file.filename);
        }
        return req;
    }

    async function waitForJob(jobId: string): Promise<CvBulkImportResponseDTO> {
        const deadline = Date.now() + 10_000;
        for (;;) {
            const res = await request.get(`/candidates/cv/bulk/${jobId}`);
            expect(res.status).toBe(200);
            const dto = res.body as CvBulkImportResponseDTO;
            if (dto.status !== "running") {
                return dto;
            }
            if (Date.now() > deadline) {
                throw new Error("el job no terminó a tiempo");
            }
            await new Promise((resolve) => setTimeout(resolve, 15));
        }
    }

    function candidateRows(): Array<{
        id: string;
        name: string;
        analysis_status: string;
        cv_summary: string | null;
    }> {
        return db
            .prepare(
                "SELECT id, name, analysis_status, cv_summary FROM candidate ORDER BY rowid",
            )
            .all() as never;
    }

    const txt = (filename = "cv_ana-perez.txt"): Attachment => ({
        buffer: fixture("cv-sample.txt"),
        filename,
    });

    it("camino feliz: 202, candidatos con nombre deducido y resúmenes persistidos", async () => {
        await createProcess();

        const res = await bulk([
            txt("cv_ana-perez.txt"),
            { buffer: fixture("cv-sample.pdf"), filename: "Luis GÓMEZ - CV.pdf" },
            { buffer: fixture("cv-sample.docx"), filename: "marta_ruiz.docx" },
        ]);
        expect(res.status).toBe(202);
        const started = res.body as CvBulkImportResponseDTO;
        lastJobId = started.jobId;
        expect(started.status).toBe("running");
        expect(started.filesDeleted).toBe(true);
        expect(started.counts.total).toBe(3);
        // Mayúsculas y minúsculas mezcladas se respetan; todo minúsculas se
        // pone en Título.
        expect(started.items.map((item) => item.name)).toEqual([
            "Ana Perez",
            "Luis GÓMEZ",
            "Marta Ruiz",
        ]);
        expect(started.items.every((item) => item.candidateId)).toBe(true);
        // El texto extraído no viaja jamás en el DTO.
        expect(JSON.stringify(started)).not.toContain(TXT_MARKER);

        const done = await waitForJob(started.jobId);
        expect(done.status).toBe("done");
        expect(done.counts.summarized).toBe(3);
        expect(done.items.every((item) => item.status === "summarized")).toBe(
            true,
        );
        expect(done.items[0].extractedChars).toBeGreaterThan(0);
        expect(done.items[0].truncated).toBe(false);
        expect(done.finishedAt).not.toBeNull();

        const rows = candidateRows();
        expect(rows.map((row) => row.name)).toEqual([
            "Ana Perez",
            "Luis GÓMEZ",
            "Marta Ruiz",
        ]);
        expect(rows.every((row) => row.analysis_status === "summarized")).toBe(
            true,
        );
        expect(JSON.parse(rows[0].cv_summary as string)).toEqual(
            validSummary(),
        );
        expect(mock.requests).toHaveLength(3);
        // El texto SÍ llegó al modelo local…
        expect(mock.requests[0].body.messages[0].content).toContain(TXT_MARKER);
        // …y no sobrevive en ninguna tabla.
        for (const table of ["candidate", "process", "app_event"]) {
            const dump = JSON.stringify(
                db.prepare(`SELECT * FROM ${table}`).all(),
            );
            expect(dump).not.toContain(SENTINEL_PERSONAL_DATA);
            expect(dump).not.toContain(TXT_MARKER);
        }

        // Auditoría: alta por candidato + inicio y fin del lote, solo conteos.
        expect(eventsByAction(db, "candidate.created")).toHaveLength(3);
        expect(eventsByAction(db, "candidate.cv_extracted")).toHaveLength(3);
        const startedEvents = eventsByAction(db, "candidate.cv_bulk_started");
        expect(startedEvents).toHaveLength(1);
        expect(JSON.parse(startedEvents[0].metadata as string)).toMatchObject({
            jobId: started.jobId,
            files: 3,
            accepted: 3,
            rejected: 0,
        });
        const finished = eventsByAction(db, "candidate.cv_bulk_finished");
        expect(finished).toHaveLength(1);
        expect(JSON.parse(finished[0].metadata as string)).toMatchObject({
            status: "done",
            summarized: 3,
            failed: 0,
        });
    });

    it("names sobreescribe el nombre deducido; vacío deduce; repetidos se numeran", async () => {
        await createProcess();
        const res = await bulk(
            [txt("cv.txt"), txt("cv.txt"), txt("ana.txt")],
            ["  Ana Pérez ", "", null],
        );
        expect(res.status).toBe(202);
        lastJobId = res.body.jobId;
        expect(
            (res.body as CvBulkImportResponseDTO).items.map((i) => i.name),
        ).toEqual(["Ana Pérez", "Candidato 2", "Ana"]);
        expect(candidateRows().map((row) => row.name)).toEqual([
            "Ana Pérez",
            "Candidato 2",
            "Ana",
        ]);
    });

    it("dos archivos con el mismo nombre deducido → 'Nombre' y 'Nombre (2)'", async () => {
        await createProcess();
        const res = await bulk([txt("ana_perez.txt"), txt("Ana-Perez.txt")]);
        expect(res.status).toBe(202);
        lastJobId = res.body.jobId;
        expect(candidateRows().map((row) => row.name)).toEqual([
            "Ana Perez",
            "Ana Perez (2)",
        ]);
    });

    it("names mal formado → 400 sin crear nada", async () => {
        await createProcess();
        let res = await request
            .post("/candidates/cv/bulk")
            .field("names", "no es json")
            .attach("files", fixture("cv-sample.txt"), "a.txt");
        expect(res.status).toBe(400);
        res = await bulk([txt()], ["uno", "dos"]);
        expect(res.status).toBe(400);
        res = await bulk([txt()], ["x".repeat(201)]);
        expect(res.status).toBe(400);
        expect(candidateRows()).toHaveLength(0);
    });

    it("un formato no admitido se rechaza solo; el resto del lote sigue", async () => {
        await createProcess();
        const res = await bulk([
            txt("ana.txt"),
            { buffer: Buffer.from("x"), filename: "notas.md" },
            { buffer: fixture("cv-sample.txt"), filename: "b.txt", contentType: "application/pdf" },
            txt("luis.txt"),
        ]);
        expect(res.status).toBe(202);
        lastJobId = res.body.jobId;
        const done = await waitForJob(res.body.jobId);
        expect(done.items.map((item) => item.status)).toEqual([
            "summarized",
            "rejected",
            "rejected",
            "summarized",
        ]);
        expect(done.items[1]).toMatchObject({
            candidateId: null,
            name: null,
            errorCode: "UNSUPPORTED_MEDIA_TYPE",
        });
        expect(done.counts).toMatchObject({ rejected: 2, summarized: 2 });
        expect(candidateRows()).toHaveLength(2);
        expect(
            JSON.parse(
                eventsByAction(db, "candidate.cv_bulk_started")[0]
                    .metadata as string,
            ),
        ).toMatchObject({ files: 4, accepted: 2, rejected: 2 });
    });

    it("todos los formatos no admitidos → 415 sin crear nada", async () => {
        await createProcess();
        const res = await bulk([
            { buffer: Buffer.from("x"), filename: "a.exe" },
            { buffer: Buffer.from("x"), filename: "b.md" },
        ]);
        expect(res.status).toBe(415);
        expect(res.body.error.code).toBe("UNSUPPORTED_MEDIA_TYPE");
        expect(candidateRows()).toHaveLength(0);
    });

    it("PDF corrupto: candidato creado en 'failed', el resto se resume", async () => {
        await createProcess();
        const res = await bulk([
            { buffer: Buffer.from("no es un pdf"), filename: "roto.pdf" },
            txt("ana.txt"),
        ]);
        expect(res.status).toBe(202);
        lastJobId = res.body.jobId;
        const done = await waitForJob(res.body.jobId);
        expect(done.items[0]).toMatchObject({
            status: "failed",
            errorCode: "INVALID_INPUT",
        });
        expect(done.items[0].candidateId).not.toBeNull();
        expect(done.items[1].status).toBe("summarized");
        const rows = candidateRows();
        expect(rows[0].analysis_status).toBe("failed");
        expect(rows[1].analysis_status).toBe("summarized");
    });

    it("sin archivos → 400", async () => {
        await createProcess();
        const res = await request
            .post("/candidates/cv/bulk")
            .field("names", "[]");
        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe("INVALID_INPUT");
    });

    it("un archivo de más de 10 MB tumba el lote entero con 413 antes de crear nada", async () => {
        await createProcess();
        const big = Buffer.alloc(MAX_CV_MB * 1024 * 1024 + 1, 0x61);
        const res = await bulk([txt(), { buffer: big, filename: "gigante.txt" }]);
        expect(res.status).toBe(413);
        expect(res.body.error.code).toBe("FILE_TOO_LARGE");
        expect(candidateRows()).toHaveLength(0);
        expect(mock.requests).toHaveLength(0);
    });

    it(`más de ${MAX_BULK_CV_FILES} archivos → 422 antes de crear nada`, async () => {
        await createProcess();
        const files = Array.from({ length: MAX_BULK_CV_FILES + 1 }, (_, i) =>
            txt(`c${i}.txt`),
        );
        const res = await bulk(files);
        expect(res.status).toBe(422);
        expect(res.body.error.code).toBe("LIMIT_EXCEEDED");
        expect(candidateRows()).toHaveLength(0);
    });

    it("el lote no cabe en los 100 candidatos → 422 y no se crea ninguno", async () => {
        const processId = await createProcess();
        const insert = db.prepare(
            "INSERT INTO candidate (id, process_id, name) VALUES (?, ?, ?)",
        );
        for (let i = 0; i < MAX_CANDIDATES_PER_PROCESS - 1; i++) {
            insert.run(newId(), processId, `C${i}`);
        }
        const res = await bulk([txt("a.txt"), txt("b.txt")]);
        expect(res.status).toBe(422);
        expect(res.body.error.code).toBe("LIMIT_EXCEEDED");
        expect(candidateRows()).toHaveLength(MAX_CANDIDATES_PER_PROCESS - 1);
        // El rechazo no ocupó el job: el siguiente lote que sí cabe entra.
        const ok = await bulk([txt("a.txt")]);
        expect(ok.status).toBe(202);
        lastJobId = ok.body.jobId;
    });

    it("cupo por hora: si no caben todas las extracciones, 429 sin consumir ni crear", async () => {
        await createProcess();
        rateLimiter.checkMany(
            CV_EXTRACT_RATE_KEY,
            RATE_LIMITS_PER_HOUR.EXTRACT,
            RATE_LIMITS_PER_HOUR.EXTRACT - 1,
        );
        const res = await bulk([txt("a.txt"), txt("b.txt")]);
        expect(res.status).toBe(429);
        expect(res.body.error.code).toBe("RATE_LIMITED");
        expect(candidateRows()).toHaveLength(0);
        // Queda exactamente un hueco: un lote de uno entra.
        const ok = await bulk([txt("a.txt")]);
        expect(ok.status).toBe(202);
        lastJobId = ok.body.jobId;
    });

    it("solo un lote a la vez: el segundo responde 422 mientras el primero corre", async () => {
        await createProcess();
        // El modelo tarda: el primer lote sigue vivo cuando llega el segundo.
        responder = async () => {
            await new Promise((resolve) => setTimeout(resolve, 150));
            return chatCompletion(validSummary());
        };
        const first = await bulk([txt("a.txt"), txt("b.txt")]);
        expect(first.status).toBe(202);
        lastJobId = first.body.jobId;
        const second = await bulk([txt("c.txt")]);
        expect(second.status).toBe(422);
        expect(second.body.error.code).toBe("LIMIT_EXCEEDED");
        expect(candidateRows()).toHaveLength(2);
        const done = await waitForJob(first.body.jobId);
        expect(done.counts.summarized).toBe(2);
    });

    it("cancelar deja los que faltaban en 'cancelled' con su candidato en 'pending'", async () => {
        await createProcess();
        responder = async () => {
            await new Promise((resolve) => setTimeout(resolve, 150));
            return chatCompletion(validSummary());
        };
        const res = await bulk([txt("a.txt"), txt("b.txt"), txt("c.txt")]);
        expect(res.status).toBe(202);
        lastJobId = res.body.jobId;

        const cancelled = await request.delete(
            `/candidates/cv/bulk/${res.body.jobId}`,
        );
        expect(cancelled.status).toBe(200);
        // Se pide cancelar; el job sigue `running` hasta que el CV en vuelo
        // termina, para que la UI siga haciendo polling hasta entonces.
        expect(cancelled.body.cancelRequested).toBe(true);
        expect(cancelled.body.status).toBe("running");
        expect(cancelled.body.items[1].status).toBe("cancelled");

        const done = await waitForJob(res.body.jobId);
        expect(done.status).toBe("cancelled");
        // El primero ya estaba en el modelo y termina; los otros dos no empiezan.
        expect(done.items[0].status).toBe("summarized");
        expect(done.items[1].status).toBe("cancelled");
        expect(done.items[2].status).toBe("cancelled");
        const rows = candidateRows();
        expect(rows.map((row) => row.analysis_status)).toEqual([
            "summarized",
            "pending",
            "pending",
        ]);
        expect(mock.requests).toHaveLength(1);
    });

    it("modelo caído: espera y reintenta el mismo CV; si no vuelve, el lote falla y lo demás queda 'pending'", async () => {
        await createProcess();
        // Falla las dos primeras llamadas (1 fallo + 1 espera), triunfa la 3ª
        // para el primer CV; el segundo CV falla siempre.
        let calls = 0;
        responder = () => {
            calls += 1;
            if (calls <= 2 || calls > 3) {
                return { status: 500 };
            }
            return chatCompletion(validSummary());
        };
        const res = await bulk([txt("a.txt"), txt("b.txt"), txt("c.txt")]);
        expect(res.status).toBe(202);
        lastJobId = res.body.jobId;
        const done = await waitForJob(res.body.jobId);

        expect(done.status).toBe("failed");
        expect(done.errorCode).toBe("LLM_UNAVAILABLE");
        expect(done.items[0]).toMatchObject({ status: "summarized", llmWaits: 2 });
        expect(done.items[1]).toMatchObject({
            status: "failed",
            errorCode: "LLM_UNAVAILABLE",
            llmWaits: BULK_LLM_RETRY.maxWaits,
        });
        expect(done.items[2].status).toBe("cancelled");
        expect(candidateRows().map((row) => row.analysis_status)).toEqual([
            "summarized",
            "failed",
            "pending",
        ]);
    });

    it("si alguien sube un CV a mano antes de que le toque, el lote no lo pisa (skipped)", async () => {
        await createProcess();
        responder = async () => {
            await new Promise((resolve) => setTimeout(resolve, 100));
            return chatCompletion(validSummary());
        };
        const res = await bulk([txt("a.txt"), txt("b.txt")]);
        expect(res.status).toBe(202);
        lastJobId = res.body.jobId;
        const second = res.body.items[1].candidateId as string;
        // Fuera de banda: el candidato ya tiene resumen.
        db.prepare(
            "UPDATE candidate SET analysis_status = 'summarized', cv_summary = '{}' WHERE id = ?",
        ).run(second);
        const done = await waitForJob(res.body.jobId);
        expect(done.items[0].status).toBe("summarized");
        expect(done.items[1].status).toBe("skipped");
        expect(mock.requests).toHaveLength(1);
    });

    it("proceso archivado → 409 PROCESS_CLOSED; sin proceso → 404", async () => {
        let res = await bulk([txt()]);
        expect(res.status).toBe(404);
        await createProcess();
        await request.post("/process/close").expect(200);
        res = await bulk([txt()]);
        expect(res.status).toBe(409);
        expect(res.body.error.code).toBe("PROCESS_CLOSED");
    });

    it("GET/DELETE de un job desconocido → 404; id no UUID → 400", async () => {
        await createProcess();
        expect((await request.get(`/candidates/cv/bulk/${newId()}`)).status).toBe(
            404,
        );
        expect(
            (await request.delete(`/candidates/cv/bulk/${newId()}`)).status,
        ).toBe(404);
        expect((await request.get("/candidates/cv/bulk/nope")).status).toBe(400);
    });

    it("la subida uno a uno sigue funcionando y comparte cupo con el lote", async () => {
        await createProcess();
        const res = await bulk([txt("ana.txt")]);
        expect(res.status).toBe(202);
        lastJobId = res.body.jobId;
        await waitForJob(res.body.jobId);
        const id = res.body.items[0].candidateId as string;
        const single = await request
            .post(`/candidates/${id}/cv/extract`)
            .attach("file", fixture("cv-sample.txt"), "cv-sample.txt");
        expect(single.status).toBe(200);
        expect(single.body.analysisStatus).toBe("summarized");
    });
});
