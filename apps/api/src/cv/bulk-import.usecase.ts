import { inject, injectable } from "@expressots/core";
import { CandidateRepository } from "../candidates/candidate.repository";
import {
    ProcessRepository,
    requireWritableProcess,
} from "../process/process.repository";
import { RateLimiter } from "../security/rate-limit";
import { AuditRepository } from "../shared/audit";
import { AppError, AppErrorCode } from "../shared/errors";
import { assertValidId } from "../shared/ids";
import {
    MAX_BULK_CV_FILES,
    MAX_CANDIDATES_PER_PROCESS,
    MAX_EXTRACTED_CHARS,
    RATE_LIMITS_PER_HOUR,
} from "../shared/limits";
import { BulkImportItem, BulkImportJobRegistry } from "./bulk-import-job";
import { candidateNameFromFilename, dedupeNames } from "./candidate-name";
import {
    CvBulkImportResponseDTO,
    parseBulkNames,
    toBulkImportDTO,
    UploadedCvFile,
    validateUploadedCv,
} from "./cv.dto";
import { CvSummarizer } from "./cv-summarizer";
import { CV_EXTRACT_RATE_KEY } from "./extract-cv.usecase";
import { CvKind, extractText } from "./extractors";

/**
 * Política de espera cuando el modelo deja de responder a mitad de lote:
 * se reintenta el MISMO CV cada `delayMs` hasta `maxWaits` veces antes de
 * dar el lote por fallido. Es un objeto mutable a propósito: los tests lo
 * acortan a milisegundos.
 */
export const BULK_LLM_RETRY = { delayMs: 30_000, maxWaits: 10 };

/**
 * POST /candidates/cv/bulk — carga masiva de CVs (BLUEPRINT §16, 2026-08-15).
 *
 * En el REQUEST (todo lo que es rápido y debe morir con él):
 * 1. Valida el lote entero ANTES de crear nada: cupo de candidatos del
 *    proceso, cupo de extracciones por hora y `names`. Un lote que no cabe se
 *    rechaza completo; nunca se crea medio lote.
 * 2. Clasifica cada archivo: formato admitido → candidato; formato no
 *    admitido → `rejected` sin candidato (el resto del lote sigue).
 * 3. Crea los candidatos (nombre = `names[i]` o deducido del archivo, ver
 *    `candidate-name.ts`) y EXTRAE el texto de cada archivo aquí mismo. Al
 *    salir del request los buffers se anulan (`scrubUploadedFiles`): el CV
 *    original no sobrevive al request ni en RAM (§04/§17).
 * 4. Responde 202 con el job.
 *
 * En el JOB (segundo plano, `run`): pasa el texto de cada candidato por
 * `CvSummarizer` uno a uno, soltando el texto en cuanto se resume. Cada CV
 * cuenta como una extracción del cupo por hora (§16).
 */
@injectable()
export class BulkImportCvsUseCase {
    constructor(
        @inject(ProcessRepository)
        private readonly processes: ProcessRepository,
        @inject(CandidateRepository)
        private readonly candidates: CandidateRepository,
        @inject(RateLimiter) private readonly rateLimiter: RateLimiter,
        @inject(CvSummarizer) private readonly summarizer: CvSummarizer,
        @inject(BulkImportJobRegistry)
        private readonly jobs: BulkImportJobRegistry,
        @inject(AuditRepository) private readonly audit: AuditRepository,
    ) {}

    async execute(
        files: UploadedCvFile[] | undefined,
        namesField: unknown,
    ): Promise<CvBulkImportResponseDTO> {
        if (!Array.isArray(files) || files.length === 0) {
            throw new AppError(
                "INVALID_INPUT",
                'Faltan los archivos (campo multipart "files").',
            );
        }
        if (files.length > MAX_BULK_CV_FILES) {
            throw new AppError(
                "LIMIT_EXCEEDED",
                `Demasiados archivos en un solo lote (máximo ${MAX_BULK_CV_FILES}).`,
            );
        }
        const names = parseBulkNames(namesField, files.length);
        const selected = requireWritableProcess(this.processes);

        // Formato por archivo. Un formato no admitido no tumba el lote: ese
        // archivo se reporta `rejected` y no crea candidato.
        const kinds: Array<CvKind | null> = files.map((file) => {
            try {
                return validateUploadedCv(file);
            } catch (error) {
                if (
                    error instanceof AppError &&
                    error.code === "UNSUPPORTED_MEDIA_TYPE"
                ) {
                    return null;
                }
                throw error;
            }
        });
        const acceptedCount = kinds.filter((kind) => kind !== null).length;
        if (acceptedCount === 0) {
            throw new AppError(
                "UNSUPPORTED_MEDIA_TYPE",
                "Ninguno de los archivos tiene un formato admitido (PDF, DOCX o TXT).",
            );
        }

        // El job se reserva ANTES de las comprobaciones que dependen del
        // estado (cupos) y de crear nada: dos lotes a la vez no pasan ambos.
        const job = this.jobs.start(selected.id);
        if (!job) {
            throw new AppError(
                "LIMIT_EXCEEDED",
                "Ya hay una carga masiva de CVs en curso. Espera a que termine o cancélala.",
            );
        }

        const existing = this.candidates.countActive(selected.id);
        try {
            // Tope de candidatos por proceso (§16), atómico para el lote.
            if (existing + acceptedCount > MAX_CANDIDATES_PER_PROCESS) {
                throw new AppError(
                    "LIMIT_EXCEEDED",
                    `El lote no cabe en el proceso: tiene ${existing} candidatos, ` +
                        `el lote añade ${acceptedCount} y el máximo es ${MAX_CANDIDATES_PER_PROCESS}.`,
                );
            }

            // Cupo por hora (§16): cada CV es una extracción. O caben todas
            // o no se consume ninguna.
            this.rateLimiter.checkMany(
                CV_EXTRACT_RATE_KEY,
                RATE_LIMITS_PER_HOUR.EXTRACT,
                acceptedCount,
            );
        } catch (error) {
            this.jobs.discard(job.id);
            throw error;
        }

        // Nombres: el del usuario o el deducido del archivo; sin repetidos
        // dentro del lote (solo entre los que crean candidato).
        const acceptedIndexes = kinds
            .map((kind, index) => (kind === null ? -1 : index))
            .filter((index) => index >= 0);
        const dedupedNames = dedupeNames(
            acceptedIndexes.map(
                (index) =>
                    names[index] ??
                    candidateNameFromFilename(
                        files[index].originalname,
                        index,
                    ),
            ),
        );
        const nameByIndex = new Map<number, string>();
        acceptedIndexes.forEach((index, at) =>
            nameByIndex.set(index, dedupedNames[at]),
        );

        // Alta + extracción, dentro del request. El buffer de cada archivo
        // se anula en cuanto se ha extraído su texto.
        let candidateCount = existing;
        for (const [index, file] of files.entries()) {
            const kind = kinds[index];
            if (kind === null) {
                job.items.push(
                    item(index, null, null, "rejected", "UNSUPPORTED_MEDIA_TYPE"),
                );
                continue;
            }

            const row = this.candidates.create(
                selected.id,
                nameByIndex.get(index) as string,
            );
            candidateCount += 1;
            // Auditoría sin datos sensibles: ids y contador, nunca el nombre.
            this.audit.logEvent("candidate.created", "candidate", row.id, {
                processId: selected.id,
                candidateCount,
                bulkJobId: job.id,
            });

            try {
                const text = await extractText(file.buffer, kind);
                const entry = item(index, row.id, row.name, "queued", null);
                // Se retiene solo lo que el modelo va a leer (§16: 50k).
                entry.text = text.slice(0, MAX_EXTRACTED_CHARS);
                entry.extractedChars = text.length;
                job.items.push(entry);
            } catch {
                // Archivo ilegible: candidato creado en 'failed', reintentable
                // con una subida individual. El resto del lote sigue.
                this.candidates.setAnalysisStatus(row.id, "failed");
                job.items.push(
                    item(index, row.id, row.name, "failed", "INVALID_INPUT"),
                );
            } finally {
                file.buffer = Buffer.alloc(0);
            }
        }

        // Auditoría del lote SIN contenido (§17): solo conteos.
        this.audit.logEvent("candidate.cv_bulk_started", "process", selected.id, {
            jobId: job.id,
            files: files.length,
            accepted: acceptedCount,
            rejected: files.length - acceptedCount,
        });

        void this.run(job.id);
        return toBulkImportDTO(job);
    }

    /** GET /candidates/cv/bulk/:jobId — estado del lote. */
    status(jobId: unknown): CvBulkImportResponseDTO {
        assertValidId(jobId);
        const job = this.jobs.find(jobId);
        if (!job) {
            throw new AppError("NOT_FOUND");
        }
        return toBulkImportDTO(job);
    }

    /**
     * DELETE /candidates/cv/bulk/:jobId — cancela el lote. El CV que esté en
     * el modelo termina; los que faltaban quedan `cancelled` con su candidato
     * en `pending`, listo para una subida individual o para borrarlo.
     */
    cancel(jobId: unknown): CvBulkImportResponseDTO {
        assertValidId(jobId);
        const job = this.jobs.cancel(jobId);
        if (!job) {
            throw new AppError("NOT_FOUND");
        }
        return toBulkImportDTO(job);
    }

    /** Segundo plano: un CV detrás de otro por el modelo. */
    private async run(jobId: string): Promise<void> {
        const job = this.jobs.find(jobId);
        if (!job) {
            return;
        }
        const startedAt = Date.now();

        for (const entry of job.items) {
            if (entry.status !== "queued") {
                continue;
            }
            // `cancel`/`fail` ya habrán pasado los `queued` a `cancelled`;
            // esta guarda cubre el instante entre el bucle y el registro.
            if (job.status !== "running" || job.cancelRequested) {
                break;
            }
            await this.processItem(job.processId, entry, jobId);
            if (job.status !== "running") {
                break;
            }
        }

        this.jobs.finish(jobId);

        // Auditoría del resultado SIN contenido (§17): solo conteos.
        const counts = toBulkImportDTO(job).counts;
        this.audit.logEvent("candidate.cv_bulk_finished", "process", job.processId, {
            jobId,
            status: job.status,
            summarized: counts.summarized,
            failed: counts.failed,
            skipped: counts.skipped,
            cancelled: counts.cancelled,
            durationMs: Date.now() - startedAt,
        });
    }

    private async processItem(
        processId: string,
        entry: BulkImportItem,
        jobId: string,
    ): Promise<void> {
        const candidateId = entry.candidateId as string;
        try {
            // El mundo puede haber cambiado desde el 202: proceso archivado,
            // candidato borrado o alguien que ya le subió un CV a mano.
            const process = this.processes.findById(processId);
            if (!process || process.status === "closed") {
                settle(entry, "failed", "PROCESS_CLOSED");
                return;
            }
            const candidate = this.candidates.findActiveInProcess(
                candidateId,
                processId,
            );
            if (!candidate) {
                settle(entry, "failed", "NOT_FOUND");
                return;
            }
            if (candidate.analysis_status !== "pending") {
                settle(entry, "skipped", null);
                return;
            }

            entry.status = "summarizing";
            const text = entry.text ?? "";
            for (;;) {
                try {
                    const outcome = await this.summarizer.summarize(
                        candidateId,
                        text,
                        process,
                    );
                    entry.truncated = outcome.truncated;
                    settle(entry, "summarized", null);
                    return;
                } catch (error) {
                    const code: AppErrorCode =
                        error instanceof AppError
                            ? error.code
                            : "LLM_UNAVAILABLE";
                    if (
                        code !== "LLM_UNAVAILABLE" ||
                        entry.llmWaits >= BULK_LLM_RETRY.maxWaits
                    ) {
                        settle(entry, "failed", code);
                        if (code === "LLM_UNAVAILABLE") {
                            // Sin modelo no hay lote: lo que falta se suelta
                            // en vez de fallar veinte veces seguidas.
                            this.jobs.fail(jobId, code);
                        }
                        return;
                    }
                    // Modelo caído: se espera y se reintenta el MISMO CV. El
                    // candidato vuelve a 'pending' mientras tanto: si el
                    // lote muere aquí no queda ningún 'extracting' colgado.
                    entry.llmWaits += 1;
                    this.candidates.setAnalysisStatus(candidateId, "pending");
                    await sleep(BULK_LLM_RETRY.delayMs);
                    const current = this.jobs.find(jobId);
                    if (current?.status !== "running" || current.cancelRequested) {
                        settle(entry, "cancelled", null);
                        return;
                    }
                    if (
                        this.candidates.findActiveInProcess(
                            candidateId,
                            processId,
                        )?.analysis_status !== "pending"
                    ) {
                        // Mientras esperábamos alguien le subió un CV a mano
                        // (o lo borró): ese trabajo no se pisa.
                        settle(entry, "skipped", null);
                        return;
                    }
                }
            }
        } catch {
            // Nada de aquí debe tumbar el bucle; el error no lleva contenido.
            settle(entry, "failed", "INVALID_INPUT");
        }
    }
}

/** Marca el estado final del item y suelta su texto. */
function settle(
    entry: BulkImportItem,
    status: BulkImportItem["status"],
    errorCode: AppErrorCode | null,
): void {
    entry.status = status;
    entry.errorCode = errorCode;
    entry.text = null;
}

function item(
    index: number,
    candidateId: string | null,
    name: string | null,
    status: BulkImportItem["status"],
    errorCode: AppErrorCode | null,
): BulkImportItem {
    return {
        index,
        candidateId,
        name,
        status,
        errorCode,
        extractedChars: null,
        truncated: null,
        llmWaits: 0,
        text: null,
    };
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
