import { AppError } from "../shared/errors";
import { AnalysisStatus, CandidateRow } from "./candidate.repository";

/**
 * DTOs y validación de entrada del dominio Candidates.
 * Los mensajes de error nunca reflejan el valor recibido.
 */

/** Longitud máxima del nombre de un candidato. */
export const MAX_CANDIDATE_NAME_LENGTH = 200;

/** Elemento de GET /candidates. */
export interface CandidateListItemDTO {
    id: string;
    name: string;
    analysisStatus: AnalysisStatus;
    createdAt: string;
}

/** Detalle completo de GET /candidates/:id. */
export interface CandidateDetailDTO extends CandidateListItemDTO {
    processId: string;
    /** Resumen estructurado del CV, parseado desde JSON (null si aún no hay). */
    cvSummary: unknown;
    /** Evidencias por criterio, parseadas desde JSON (null si aún no hay). */
    cvEvidence: unknown;
    updatedAt: string;
}

/** Respuesta de DELETE /candidates/:id (borrado lógico). */
export interface CandidateDeleteResponseDTO {
    id: string;
    deleted: true;
}

export function toCandidateListItem(row: CandidateRow): CandidateListItemDTO {
    return {
        id: row.id,
        name: row.name,
        analysisStatus: row.analysis_status,
        createdAt: row.created_at,
    };
}

/**
 * Columnas JSON escritas por la propia app; si por corrupción no parsean,
 * se devuelve null en lugar de romper (y sin volcar el contenido crudo).
 */
function parseJsonColumn(value: string | null): unknown {
    if (value === null) {
        return null;
    }
    try {
        return JSON.parse(value) as unknown;
    } catch {
        return null;
    }
}

export function toCandidateDetail(row: CandidateRow): CandidateDetailDTO {
    return {
        ...toCandidateListItem(row),
        processId: row.process_id,
        cvSummary: parseJsonColumn(row.cv_summary),
        cvEvidence: parseJsonColumn(row.cv_evidence),
        updatedAt: row.updated_at,
    };
}

/** Entrada de POST /candidates y PATCH /candidates/:id: `{ name }`. */
export function parseCandidateNameInput(body: unknown): { name: string } {
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
        throw new AppError("INVALID_INPUT", "El cuerpo de la petición no es válido.");
    }
    const { name } = body as Record<string, unknown>;
    if (typeof name !== "string") {
        throw new AppError("INVALID_INPUT", "name es obligatorio y debe ser texto.");
    }
    const trimmed = name.trim();
    if (trimmed.length === 0) {
        throw new AppError("INVALID_INPUT", "name no puede estar vacío.");
    }
    if (trimmed.length > MAX_CANDIDATE_NAME_LENGTH) {
        throw new AppError("INVALID_INPUT", "name es demasiado largo.");
    }
    return { name: trimmed };
}
