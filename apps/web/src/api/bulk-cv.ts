import { ApiError, NETWORK_ERROR_CODE } from "./client";

/**
 * Carga masiva de CVs (§16, 2026-08-15): tipos espejo de los DTOs de
 * `apps/api/src/cv/cv.dto.ts` y llamadas al backend.
 *
 * Vive en su propio módulo (y no en `types.ts` / `client.ts`) solo porque
 * esos dos archivos son compartidos y se cablean al final; el contrato es el
 * mismo que el resto del cliente: mismos errores `ApiError`, mismo prefijo
 * `/api`. Cuando se integre basta con mover los tipos a `types.ts` y las
 * funciones a `api` en `client.ts`.
 */

export type BulkImportJobStatus = "running" | "done" | "failed" | "cancelled";

export type BulkImportItemStatus =
    | "rejected"
    | "queued"
    | "summarizing"
    | "summarized"
    | "failed"
    | "skipped"
    | "cancelled";

export interface CvBulkImportItemDTO {
    /** Posición del archivo en la subida (0-based). */
    index: number;
    /** null si el archivo se rechazó antes de crear candidato. */
    candidateId: string | null;
    name: string | null;
    status: BulkImportItemStatus;
    errorCode: string | null;
    extractedChars: number | null;
    truncated: boolean | null;
    llmWaits: number;
}

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

export interface CvBulkImportResponseDTO {
    jobId: string;
    processId: string;
    status: BulkImportJobStatus;
    startedAt: string;
    finishedAt: string | null;
    errorCode: string | null;
    cancelRequested: boolean;
    counts: CvBulkImportCountsDTO;
    items: CvBulkImportItemDTO[];
    filesDeleted: true;
}

/** Máximo de archivos por lote (espejo de MAX_BULK_CV_FILES del backend). */
export const MAX_BULK_CV_FILES = 30;

/** Tamaño máximo por CV en MB (espejo de MAX_CV_MB del backend). */
export const MAX_CV_MB = 10;

/** Misma lógica que `request` en client.ts (no está exportada de allí). */
async function bulkRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
    let response: Response;
    try {
        response = await fetch(`/api${path}`, init);
    } catch {
        throw new ApiError(
            NETWORK_ERROR_CODE,
            "No se pudo contactar con la API local.",
            0,
        );
    }
    let body: unknown = null;
    try {
        body = await response.json();
    } catch {
        body = null;
    }
    if (!response.ok) {
        const error =
            typeof body === "object" && body !== null && "error" in body
                ? (body as { error: { code?: unknown; message?: unknown } })
                      .error
                : null;
        const code =
            error && typeof error.code === "string" ? error.code : "UNKNOWN";
        const message =
            error && typeof error.message === "string"
                ? error.message
                : "Error inesperado de la API.";
        throw new ApiError(code, message, response.status);
    }
    return body as T;
}

export const bulkCvApi = {
    /**
     * Sube varios CVs de golpe. `names[i]` es el nombre que quiere el usuario
     * para el archivo i, o null para deducirlo del nombre del archivo. El
     * campo `names` solo viaja si hay alguno relleno.
     */
    start(
        files: File[],
        names: Array<string | null>,
    ): Promise<CvBulkImportResponseDTO> {
        const form = new FormData();
        if (names.some((name) => name !== null)) {
            form.append("names", JSON.stringify(names));
        }
        for (const file of files) {
            form.append("files", file);
        }
        return bulkRequest("/candidates/cv/bulk", {
            method: "POST",
            body: form,
        });
    },
    status(jobId: string): Promise<CvBulkImportResponseDTO> {
        return bulkRequest(`/candidates/cv/bulk/${encodeURIComponent(jobId)}`);
    },
    cancel(jobId: string): Promise<CvBulkImportResponseDTO> {
        return bulkRequest(
            `/candidates/cv/bulk/${encodeURIComponent(jobId)}`,
            { method: "DELETE" },
        );
    },
};
