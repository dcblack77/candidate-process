import { AppError } from "../shared/errors";
import { MAX_QUESTIONS_PER_CANDIDATE } from "../shared/limits";
import { InterviewQuestionRow } from "./question.repository";

/**
 * DTOs y validación de entrada del dominio Questions.
 * Los mensajes de error nunca reflejan los valores recibidos.
 */

/** Número de preguntas por defecto si el body no trae `count`. */
export const DEFAULT_QUESTION_COUNT = 8;

/** Pregunta de entrevista con el bloque completo de §14, señales parseadas. */
export interface InterviewQuestionDTO {
    id: string;
    criterion: string;
    dimension: string;
    question: string;
    validates: string | null;
    idealAnswer: string | null;
    positiveSignals: string[];
    warningSignals: string[];
    scoringGuidance: string | null;
    createdAt: string;
}

/** Respuesta de POST /candidates/:id/questions. */
export interface GenerateQuestionsResponseDTO {
    candidateId: string;
    /** Preguntas creadas en ESTA llamada. */
    questions: InterviewQuestionDTO[];
    /** Total de preguntas persistidas del candidato tras la llamada. */
    questionsTotal: number;
    questionsLimit: number;
}

/** Columna JSON de señales; si no parsea devuelve lista vacía. */
function parseSignals(value: string | null): string[] {
    if (value === null) {
        return [];
    }
    try {
        const parsed: unknown = JSON.parse(value);
        return Array.isArray(parsed)
            ? parsed.filter((s): s is string => typeof s === "string")
            : [];
    } catch {
        return [];
    }
}

export function toQuestionDTO(row: InterviewQuestionRow): InterviewQuestionDTO {
    return {
        id: row.id,
        criterion: row.criterion,
        dimension: row.dimension,
        question: row.question,
        validates: row.validates,
        idealAnswer: row.ideal_answer,
        positiveSignals: parseSignals(row.positive_signals),
        warningSignals: parseSignals(row.warning_signals),
        scoringGuidance: row.scoring_guidance,
        createdAt: row.created_at,
    };
}

/**
 * Entrada de POST /candidates/:id/questions: `{ count? }`. Body ausente o
 * vacío → DEFAULT_QUESTION_COUNT; count debe ser entero 1-20.
 */
export function parseQuestionCountInput(body: unknown): { count: number } {
    if (body === undefined || body === null) {
        return { count: DEFAULT_QUESTION_COUNT };
    }
    if (typeof body !== "object" || Array.isArray(body)) {
        throw new AppError(
            "INVALID_INPUT",
            "El cuerpo de la petición no es válido.",
        );
    }
    const { count } = body as Record<string, unknown>;
    if (count === undefined) {
        return { count: DEFAULT_QUESTION_COUNT };
    }
    if (
        typeof count !== "number" ||
        !Number.isInteger(count) ||
        count < 1 ||
        count > MAX_QUESTIONS_PER_CANDIDATE
    ) {
        throw new AppError(
            "INVALID_INPUT",
            `count debe ser un entero entre 1 y ${MAX_QUESTIONS_PER_CANDIDATE}.`,
        );
    }
    return { count };
}
