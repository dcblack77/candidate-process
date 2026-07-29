import { Criterion, CRITERIA, EvidenceItem } from "../ai/schemas/common";
import { AppError } from "../shared/errors";
import { CandidateScoreRow } from "./score.repository";

/**
 * DTOs y validación de entrada del dominio Scoring.
 * Los mensajes de error nunca reflejan los valores recibidos.
 */

/** Longitud máxima de las notas privadas del evaluador. */
export const MAX_MANUAL_NOTES_LENGTH = 10_000;

/** Score sugerido por el modelo para un criterio (respuesta de /analyze). */
export interface SuggestedCriterionScoreDTO {
    score: number;
    rationale: string;
    evidence: EvidenceItem[];
}

/** Respuesta de POST /candidates/:id/analyze (contrato del plan). */
export interface AnalyzeResponseDTO {
    candidateId: string;
    analysisStatus: "analyzed";
    suggestedScores: Record<Criterion, SuggestedCriterionScoreDTO>;
    /** Calculado SIEMPRE por el backend con scoring/weights.ts. */
    finalScore: number;
    confidence: number;
    doubts: string[];
    risks: string[];
    regenerationsUsed: number;
    regenerationsLimit: number;
}

/** Score completo del candidato (respuesta de PATCH /score y GET /candidates/:id). */
export interface CandidateScoreDTO {
    candidateId: string;
    scores: Record<Criterion, number | null>;
    finalScore: number | null;
    confidence: number | null;
    /** {criteria, doubts, risks} del último análisis, parseado (o null). */
    evidenceSummary: unknown;
    manualNotes: string | null;
    updatedAt: string;
}

/** Respuesta de POST /candidates/:id/notes. Nunca repite el contenido. */
export interface AddNoteResponseDTO {
    candidateId: string;
    notesSaved: true;
}

/** Entrada validada de PATCH /candidates/:id/score. */
export interface ScorePatchInput {
    criteria: Partial<Record<Criterion, number>>;
    confidence?: number;
    manualNotes?: string;
}

function assertPlainObject(
    body: unknown,
): asserts body is Record<string, unknown> {
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
        throw new AppError(
            "INVALID_INPUT",
            "El cuerpo de la petición no es válido.",
        );
    }
}

function isInt1to5(value: unknown): value is number {
    return (
        typeof value === "number" &&
        Number.isInteger(value) &&
        value >= 1 &&
        value <= 5
    );
}

/**
 * Valida el body parcial de PATCH /candidates/:id/score:
 * criterios enteros 1-5, confidence 0-1, manualNotes texto. Rechaza campos
 * desconocidos y cuerpos sin ningún campo editable.
 */
export function parseScorePatchInput(body: unknown): ScorePatchInput {
    assertPlainObject(body);

    const allowed = new Set<string>([...CRITERIA, "confidence", "manualNotes"]);
    for (const key of Object.keys(body)) {
        if (!allowed.has(key)) {
            throw new AppError(
                "INVALID_INPUT",
                "El cuerpo contiene campos no permitidos.",
            );
        }
    }

    const criteria: Partial<Record<Criterion, number>> = {};
    for (const criterion of CRITERIA) {
        const value = body[criterion];
        if (value === undefined) {
            continue;
        }
        if (!isInt1to5(value)) {
            throw new AppError(
                "INVALID_INPUT",
                "Cada criterio debe ser un entero entre 1 y 5.",
            );
        }
        criteria[criterion] = value;
    }

    const result: ScorePatchInput = { criteria };

    if (body.confidence !== undefined) {
        const { confidence } = body;
        if (
            typeof confidence !== "number" ||
            confidence < 0 ||
            confidence > 1
        ) {
            throw new AppError(
                "INVALID_INPUT",
                "confidence debe ser un número entre 0 y 1.",
            );
        }
        result.confidence = confidence;
    }

    if (body.manualNotes !== undefined) {
        const { manualNotes } = body;
        if (
            typeof manualNotes !== "string" ||
            manualNotes.length > MAX_MANUAL_NOTES_LENGTH
        ) {
            throw new AppError(
                "INVALID_INPUT",
                "manualNotes debe ser texto de tamaño razonable.",
            );
        }
        result.manualNotes = manualNotes;
    }

    if (
        Object.keys(criteria).length === 0 &&
        result.confidence === undefined &&
        result.manualNotes === undefined
    ) {
        throw new AppError(
            "INVALID_INPUT",
            "No se envió ningún campo editable.",
        );
    }

    return result;
}

/** Entrada de POST /candidates/:id/notes: `{ notes }` (texto, puede ser vacío). */
export function parseNotesInput(body: unknown): { notes: string } {
    assertPlainObject(body);
    const { notes } = body;
    if (typeof notes !== "string") {
        throw new AppError(
            "INVALID_INPUT",
            "notes es obligatorio y debe ser texto.",
        );
    }
    if (notes.length > MAX_MANUAL_NOTES_LENGTH) {
        throw new AppError("INVALID_INPUT", "notes es demasiado largo.");
    }
    return { notes };
}

/**
 * Columna JSON escrita por la propia app; si no parsea se devuelve null
 * sin volcar el contenido crudo.
 */
export function parseJsonColumn(value: string | null): unknown {
    if (value === null) {
        return null;
    }
    try {
        return JSON.parse(value) as unknown;
    } catch {
        return null;
    }
}

export function toCandidateScoreDTO(row: CandidateScoreRow): CandidateScoreDTO {
    return {
        candidateId: row.candidate_id,
        scores: {
            adaptability: row.adaptability,
            fundamentals: row.fundamentals,
            depth: row.depth,
            production: row.production,
            stack: row.stack,
        },
        finalScore: row.final_score,
        confidence: row.confidence,
        evidenceSummary: parseJsonColumn(row.evidence_summary),
        manualNotes: row.manual_notes,
        updatedAt: row.updated_at,
    };
}
