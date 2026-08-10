import { Criterion, CRITERIA, EvidenceItem } from "../ai/schemas/common";
import {
    CRITERION_VERDICTS,
    CriterionVerdict,
} from "../ai/schemas/score-candidate";
import { AppError } from "../shared/errors";
import { CandidateScoreRow } from "./score.repository";
import { computeOverallScore } from "./weights";

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
    /** Resultado del contraste con la entrevista (§13). */
    verdict: CriterionVerdict;
}

/** Respuesta de POST /candidates/:id/analyze (contrato del plan). */
export interface AnalyzeResponseDTO {
    candidateId: string;
    analysisStatus: "analyzed";
    suggestedScores: Record<Criterion, SuggestedCriterionScoreDTO>;
    /** Score de la RÚBRICA (§06): calculado SIEMPRE por scoring/weights.ts. */
    cvScore: number;
    /** @deprecated Alias histórico de `cvScore`; mismo valor. */
    finalScore: number;
    /** Nota global de entrevista del candidato (1-10) o null. */
    interviewScore: number | null;
    /** Score final combinado 30% CV / 70% entrevista (§06). */
    overallScore: number;
    /** true si `overallScore` es solo el score de CV (sin entrevista). */
    provisional: boolean;
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
    /** Score de la rúbrica §06 (el persistido); null si falta algún criterio. */
    cvScore: number | null;
    /** @deprecated Alias histórico de `cvScore`; mismo valor. */
    finalScore: number | null;
    /** Nota global de entrevista (1-10) o null si no hay respuestas puntuadas. */
    interviewScore: number | null;
    /** Score final combinado 30/70 (§06); null si no hay score de CV. */
    overallScore: number | null;
    /**
     * true mientras el combinado sea solo el score de CV: sin entrevista
     * puntuada, o sin score de CV con el que combinar.
     */
    provisional: boolean;
    confidence: number | null;
    /** {criteria, doubts, risks} del último análisis, parseado (o null). */
    evidenceSummary: unknown;
    /**
     * Veredicto del contraste CV/entrevista por criterio (§13), extraído de
     * `evidenceSummary.criteria[*].verdict`. null en los análisis antiguos,
     * anteriores al contraste, que no lo guardaron.
     */
    verdicts: Record<Criterion, CriterionVerdict | null>;
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

function isHalfStep1to5(value: unknown): value is number {
    return (
        typeof value === "number" &&
        Number.isInteger(value * 2) &&
        value >= 1 &&
        value <= 5
    );
}

/**
 * Valida el body parcial de PATCH /candidates/:id/score:
 * criterios 1-5 en pasos de 0,5, confidence 0-1, manualNotes texto. Rechaza campos
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
        if (!isHalfStep1to5(value)) {
            throw new AppError(
                "INVALID_INPUT",
                "Cada criterio debe estar entre 1 y 5 en pasos de 0,5.",
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

/**
 * Veredictos persistidos en `evidence_summary.criteria[*].verdict`. Tolera
 * análisis antiguos (sin el campo) y valores desconocidos: en ambos casos
 * devuelve null para ese criterio.
 */
export function verdictsOf(
    evidenceSummary: unknown,
): Record<Criterion, CriterionVerdict | null> {
    const criteria =
        typeof evidenceSummary === "object" && evidenceSummary !== null
            ? ((evidenceSummary as { criteria?: unknown }).criteria ?? {})
            : {};
    const byCriterion = (
        typeof criteria === "object" && criteria !== null ? criteria : {}
    ) as Record<string, { verdict?: unknown } | undefined>;

    return Object.fromEntries(
        CRITERIA.map((criterion) => {
            const verdict = byCriterion[criterion]?.verdict;
            const isKnown =
                typeof verdict === "string" &&
                (CRITERION_VERDICTS as readonly string[]).includes(verdict);
            return [criterion, isKnown ? (verdict as CriterionVerdict) : null];
        }),
    ) as Record<Criterion, CriterionVerdict | null>;
}

/**
 * Proyecta la fila de score al DTO. `interviewScore` (nota global 1-10 del
 * candidato, o null) lo aporta el caso de uso porque vive en las preguntas,
 * no en esta tabla: sin él no se puede derivar el combinado de §06.
 */
export function toCandidateScoreDTO(
    row: CandidateScoreRow,
    interviewScore: number | null,
): CandidateScoreDTO {
    const evidenceSummary = parseJsonColumn(row.evidence_summary);
    const combined =
        row.final_score === null
            ? null
            : computeOverallScore(row.final_score, interviewScore);

    return {
        candidateId: row.candidate_id,
        scores: {
            adaptability: row.adaptability,
            fundamentals: row.fundamentals,
            depth: row.depth,
            production: row.production,
            stack: row.stack,
        },
        cvScore: row.final_score,
        finalScore: row.final_score,
        interviewScore,
        overallScore: combined?.overall ?? null,
        provisional: combined?.provisional ?? true,
        confidence: row.confidence,
        evidenceSummary,
        verdicts: verdictsOf(evidenceSummary),
        manualNotes: row.manual_notes,
        updatedAt: row.updated_at,
    };
}
