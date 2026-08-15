import { Criterion } from "../ai/schemas/common";
import { CriterionVerdict } from "../ai/schemas/score-candidate";
import { CriterionInterviewAverage } from "../scoring/interview-score";
import { AppError } from "../shared/errors";
import { assertValidId } from "../shared/ids";
import { MAX_COMPARISON_CANDIDATES } from "../shared/limits";

/**
 * DTOs y validación de entrada del dominio Comparison (BLUEPRINT §15, §21).
 * Los mensajes de error nunca reflejan los valores recibidos.
 */

/** Mínimo de candidatos para que "comparar" tenga sentido. */
export const MIN_COMPARISON_CANDIDATES = 2;

/** Entrada validada de POST /comparison. */
export interface ComparisonInput {
    /** Ids únicos y válidos, en el orden en que llegaron. */
    candidateIds: string[];
}

/**
 * Cabecera de cada candidato comparado: lo que la UI necesita para pintar la
 * tabla por criterios al lado del texto del modelo (§21 Comparativa) sin
 * volver a pedir el detalle de cada uno.
 */
export interface ComparedCandidateDTO {
    /** Referencia corta (C1, C2…) con la que el modelo señala al candidato. */
    ref: string;
    candidateId: string;
    name: string;
    scores: Record<Criterion, number>;
    /** Score de la rúbrica §06 (1-5): lo que promete el CV. */
    cvScore: number;
    /** Score final combinado (§06); igual a cvScore si no hay entrevista. */
    overallScore: number;
    /** true si no tiene ninguna respuesta de entrevista puntuada. */
    provisional: boolean;
    confidence: number | null;
    /** Nota global de entrevista (1-10) o null. */
    interviewScore: number | null;
    interviewByCriterion: Record<Criterion, CriterionInterviewAverage | null>;
    verdicts: Record<Criterion, CriterionVerdict | null>;
    /** Dudas pendientes de validar en entrevista según el último análisis. */
    pendingDoubts: string[];
}

/** Comparación por criterio con las referencias ya resueltas a ids. */
export interface CriterionComparisonDTO {
    /** candidateIds de quienes destacan en el criterio (puede estar vacío). */
    leaders: string[];
    analysis: string;
}

/** Empate práctico con las referencias ya resueltas a ids. */
export interface ComparisonTieDTO {
    candidateIds: string[];
    whatWouldSeparate: string;
}

/** Texto de la comparación tal y como lo propuso el modelo. */
export interface ComparisonAnalysisDTO {
    criteria: Record<Criterion, CriterionComparisonDTO>;
    evidenceQuality: string;
    profiles: string;
    ties: ComparisonTieDTO[];
    /** Dudas de entrevista que podrían cambiar la comparación. */
    openQuestions: string[];
    summary: string;
}

/** Respuesta de POST /comparison. */
export interface ComparisonResponseDTO {
    processId: string;
    roleTitle: string;
    /** ISO 8601 UTC del momento en que se generó (no se persiste). */
    generatedAt: string;
    /** Pesos de los cinco criterios (única fuente: scoring/weights.ts). */
    weights: Record<Criterion, number>;
    /** En el orden pedido: `ref` es C1 para el primero, C2 para el segundo… */
    candidates: ComparedCandidateDTO[];
    comparison: ComparisonAnalysisDTO;
    /** El sistema propone: la comparación no decide contrataciones (§01). */
    disclaimer: string;
}

/**
 * Entrada de POST /comparison: `{ candidateIds: string[] }`.
 *
 * - Entre {@link MIN_COMPARISON_CANDIDATES} y MAX_COMPARISON_CANDIDATES ids.
 * - Cada id debe ser un UUID válido y no repetirse: comparar a alguien
 *   consigo mismo no es un caso degenerado que convenga aceptar en silencio.
 * - Se rechazan claves desconocidas.
 */
export function parseComparisonInput(body: unknown): ComparisonInput {
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
        throw new AppError(
            "INVALID_INPUT",
            "El cuerpo de la petición no es válido.",
        );
    }
    const payload = body as Record<string, unknown>;
    for (const key of Object.keys(payload)) {
        if (key !== "candidateIds") {
            throw new AppError(
                "INVALID_INPUT",
                "El cuerpo contiene campos no permitidos.",
            );
        }
    }

    const { candidateIds } = payload;
    if (!Array.isArray(candidateIds)) {
        throw new AppError(
            "INVALID_INPUT",
            "candidateIds debe ser una lista de identificadores.",
        );
    }
    if (
        candidateIds.length < MIN_COMPARISON_CANDIDATES ||
        candidateIds.length > MAX_COMPARISON_CANDIDATES
    ) {
        throw new AppError(
            "INVALID_INPUT",
            `candidateIds debe tener entre ${MIN_COMPARISON_CANDIDATES} y ${MAX_COMPARISON_CANDIDATES} identificadores.`,
        );
    }
    for (const id of candidateIds) {
        assertValidId(id);
    }
    if (new Set(candidateIds).size !== candidateIds.length) {
        throw new AppError(
            "INVALID_INPUT",
            "candidateIds contiene identificadores repetidos.",
        );
    }

    return { candidateIds: candidateIds as string[] };
}
