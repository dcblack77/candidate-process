import path from "node:path";
import { MAX_CANDIDATE_NAME_LENGTH } from "../candidates/candidate.dto";
import { AnalysisStatus } from "../candidates/candidate.repository";
import { AppError, AppErrorCode } from "../shared/errors";
import {
    BulkImportItemStatus,
    BulkImportJob,
    BulkImportJobStatus,
} from "./bulk-import-job";
import { CvKind } from "./extractors";

/**
 * DTOs y validación de entrada del dominio CV (BLUEPRINT §10, §16).
 * Los mensajes de error NUNCA incluyen el nombre del archivo, el mimetype
 * recibido ni contenido: solo el motivo genérico.
 */

/** Extensiones permitidas → formato (§16: PDF, DOCX, TXT). */
const KIND_BY_EXTENSION: Record<string, CvKind> = {
    ".pdf": "pdf",
    ".docx": "docx",
    ".txt": "txt",
};

/** Mimetypes permitidos → formato. Ambas listas deben coincidir en formato. */
const KIND_BY_MIMETYPE: Record<string, CvKind> = {
    "application/pdf": "pdf",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
        "docx",
    "text/plain": "txt",
};

/** Lo único que el dominio CV necesita del archivo subido por multer. */
export interface UploadedCvFile {
    originalname: string;
    mimetype: string;
    buffer: Buffer;
}

/** Respuesta de POST /candidates/:id/cv/extract. */
export interface CvExtractResponseDTO {
    candidateId: string;
    analysisStatus: AnalysisStatus;
    /** Caracteres extraídos del CV (antes de truncar). */
    extractedChars: number;
    /** true si el texto se recortó (50k chars o presupuesto de tokens). */
    truncated: boolean;
    /** Resumen estructurado devuelto por el modelo y persistido. */
    cvSummary: unknown;
    /** El archivo original nunca se persiste (§04/§17): siempre true. */
    fileDeleted: true;
}

/**
 * Valida el archivo subido: debe existir y su extensión Y su mimetype deben
 * estar en la whitelist Y designar el mismo formato. Si falta el archivo →
 * INVALID_INPUT (400); si el formato no está permitido → UNSUPPORTED_MEDIA_TYPE (415).
 */
export function validateUploadedCv(file: UploadedCvFile | undefined): CvKind {
    if (!file || !Buffer.isBuffer(file.buffer)) {
        throw new AppError(
            "INVALID_INPUT",
            'Falta el archivo (campo multipart "file").',
        );
    }

    const extension = path.extname(file.originalname ?? "").toLowerCase();
    // El mimetype puede llegar con parámetros ("text/plain; charset=utf-8").
    const mimetype = (file.mimetype ?? "").split(";")[0].trim().toLowerCase();

    const kindByExtension = KIND_BY_EXTENSION[extension];
    const kindByMimetype = KIND_BY_MIMETYPE[mimetype];
    if (
        !kindByExtension ||
        !kindByMimetype ||
        kindByExtension !== kindByMimetype
    ) {
        throw new AppError("UNSUPPORTED_MEDIA_TYPE");
    }
    return kindByExtension;
}

// ── Carga masiva (§16, 2026-08-15) ──────────────────────────────────────────

/** Un archivo del lote en la respuesta de la carga masiva. */
export interface CvBulkImportItemDTO {
    /** Posición del archivo en la subida (0-based). */
    index: number;
    /** null si el archivo se rechazó antes de crear candidato. */
    candidateId: string | null;
    name: string | null;
    status: BulkImportItemStatus;
    errorCode: AppErrorCode | null;
    extractedChars: number | null;
    truncated: boolean | null;
    llmWaits: number;
}

/** Recuento por estado; la UI pinta la barra de progreso con esto. */
export interface CvBulkImportCountsDTO {
    total: number;
    rejected: number;
    queued: number;
    summarizing: number;
    summarized: number;
    failed: number;
    skipped: number;
    cancelled: number;
}

/**
 * Respuesta de POST /candidates/cv/bulk (202) y de GET/DELETE
 * /candidates/cv/bulk/:jobId. Nunca lleva el texto extraído (§17).
 */
export interface CvBulkImportResponseDTO {
    jobId: string;
    processId: string;
    status: BulkImportJobStatus;
    startedAt: string;
    finishedAt: string | null;
    errorCode: AppErrorCode | null;
    /** true en cuanto se pide cancelar; `status` pasa a `cancelled` al cerrar. */
    cancelRequested: boolean;
    counts: CvBulkImportCountsDTO;
    items: CvBulkImportItemDTO[];
    /** El archivo original nunca se persiste (§04/§17): siempre true. */
    filesDeleted: true;
}

export function toBulkImportDTO(job: BulkImportJob): CvBulkImportResponseDTO {
    const counts: CvBulkImportCountsDTO = {
        total: job.items.length,
        rejected: 0,
        queued: 0,
        summarizing: 0,
        summarized: 0,
        failed: 0,
        skipped: 0,
        cancelled: 0,
    };
    for (const item of job.items) {
        counts[item.status] += 1;
    }
    return {
        jobId: job.id,
        processId: job.processId,
        status: job.status,
        startedAt: job.startedAt,
        finishedAt: job.finishedAt,
        errorCode: job.errorCode,
        cancelRequested: job.cancelRequested,
        counts,
        // Copia explícita campo a campo: `text` no viaja jamás.
        items: job.items.map((item) => ({
            index: item.index,
            candidateId: item.candidateId,
            name: item.name,
            status: item.status,
            errorCode: item.errorCode,
            extractedChars: item.extractedChars,
            truncated: item.truncated,
            llmWaits: item.llmWaits,
        })),
        filesDeleted: true,
    };
}

/**
 * Campo multipart opcional `names` de la carga masiva: JSON con un array de
 * la misma longitud que `files`. Cada posición es el nombre que el usuario
 * quiere para ese archivo, o vacío/null para que se deduzca del nombre del
 * archivo. Se valida entero antes de crear nada: un lote con nombres mal
 * formados no crea medio lote.
 */
export function parseBulkNames(
    field: unknown,
    count: number,
): Array<string | null> {
    if (field === undefined || field === null || field === "") {
        return new Array<string | null>(count).fill(null);
    }
    if (typeof field !== "string") {
        throw new AppError("INVALID_INPUT", "names debe ser un JSON válido.");
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(field);
    } catch {
        throw new AppError("INVALID_INPUT", "names debe ser un JSON válido.");
    }
    if (!Array.isArray(parsed) || parsed.length !== count) {
        throw new AppError(
            "INVALID_INPUT",
            "names debe ser un array con una entrada por archivo.",
        );
    }
    return parsed.map((value) => {
        if (value === null || value === undefined) {
            return null;
        }
        if (typeof value !== "string") {
            throw new AppError(
                "INVALID_INPUT",
                "Cada entrada de names debe ser texto o null.",
            );
        }
        const trimmed = value.trim();
        if (trimmed.length === 0) {
            return null;
        }
        if (trimmed.length > MAX_CANDIDATE_NAME_LENGTH) {
            throw new AppError(
                "INVALID_INPUT",
                "Alguno de los nombres es demasiado largo.",
            );
        }
        return trimmed;
    });
}
