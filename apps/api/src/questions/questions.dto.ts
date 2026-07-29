import {
    AnsweredQuestion,
    computeInterviewScore,
    InterviewScore,
    MAX_ANSWER_SCORE,
    MIN_ANSWER_SCORE,
} from "../scoring/interview-score";
import { AppError } from "../shared/errors";
import { MAX_QUESTIONS_PER_CANDIDATE } from "../shared/limits";
import { InterviewQuestionRow } from "./question.repository";

/**
 * DTOs y validación de entrada del dominio Questions.
 * Los mensajes de error nunca reflejan los valores recibidos.
 */

/** Número de preguntas por defecto si el body no trae `count`. */
export const DEFAULT_QUESTION_COUNT = 8;

/** Longitud máxima de las notas de texto de una respuesta. */
export const MAX_ANSWER_NOTES_LENGTH = 10_000;

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
    /** Nota de la respuesta (entero 1-10); null si no está puntuada. */
    answerScore: number | null;
    /** Notas privadas sobre la respuesta (dato sensible §17); null si no hay. */
    answerNotes: string | null;
    /** ISO 8601 UTC del último registro de respuesta; null si no hay respuesta. */
    answeredAt: string | null;
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

/** Respuesta de PATCH /candidates/:id/questions/:questionId/answer. */
export interface AnswerQuestionResponseDTO {
    candidateId: string;
    /** La pregunta ya actualizada. */
    question: InterviewQuestionDTO;
    /** Agregados de entrevista del candidato RECALCULADOS tras la edición. */
    interview: InterviewScore;
}

/**
 * Entrada validada de PATCH /candidates/:id/questions/:questionId/answer.
 * `score: null` borra la nota; `notes: ""` vacía el texto. Un campo ausente
 * (undefined) se deja como estaba.
 */
export interface AnswerInput {
    score?: number | null;
    notes?: string;
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
        answerScore: row.answer_score,
        answerNotes: row.answer_notes,
        answeredAt: row.answered_at,
    };
}

/** Proyección de una fila a la entrada mínima del agregador de entrevista. */
export function toAnsweredQuestion(
    row: InterviewQuestionRow,
): AnsweredQuestion {
    return { criterion: row.criterion, answerScore: row.answer_score };
}

/**
 * Agregados de entrevista de un conjunto de filas. Único punto por el que
 * pasan detalle de candidato, ranking y export: la aritmética vive en
 * scoring/interview-score.ts (pesos desde weights.ts).
 */
export function interviewScoreOf(rows: InterviewQuestionRow[]): InterviewScore {
    return computeInterviewScore(rows.map(toAnsweredQuestion));
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

/**
 * Entrada de PATCH /candidates/:id/questions/:questionId/answer:
 * `{ score?, notes? }`.
 *
 * - score: entero entre 1 y 10, o null para borrar la nota.
 * - notes: texto que REEMPLAZA la nota anterior; "" la vacía.
 * - Se rechazan claves desconocidas y cuerpos sin ningún campo editable.
 *
 * La validación se hace también aquí (además del CHECK de la migración) para
 * responder INVALID_INPUT (400) en lugar de un error de constraint.
 */
export function parseAnswerInput(body: unknown): AnswerInput {
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
        throw new AppError(
            "INVALID_INPUT",
            "El cuerpo de la petición no es válido.",
        );
    }
    const payload = body as Record<string, unknown>;

    const allowed = new Set<string>(["score", "notes"]);
    for (const key of Object.keys(payload)) {
        if (!allowed.has(key)) {
            throw new AppError(
                "INVALID_INPUT",
                "El cuerpo contiene campos no permitidos.",
            );
        }
    }

    const result: AnswerInput = {};

    if (payload.score !== undefined) {
        const { score } = payload;
        if (score !== null && !isValidAnswerScore(score)) {
            throw new AppError(
                "INVALID_INPUT",
                `score debe ser un entero entre ${MIN_ANSWER_SCORE} y ${MAX_ANSWER_SCORE}, o null.`,
            );
        }
        result.score = score as number | null;
    }

    if (payload.notes !== undefined) {
        const { notes } = payload;
        if (typeof notes !== "string") {
            throw new AppError("INVALID_INPUT", "notes debe ser texto.");
        }
        if (notes.length > MAX_ANSWER_NOTES_LENGTH) {
            throw new AppError("INVALID_INPUT", "notes es demasiado largo.");
        }
        result.notes = notes;
    }

    if (result.score === undefined && result.notes === undefined) {
        throw new AppError(
            "INVALID_INPUT",
            "No se envió ningún campo editable.",
        );
    }

    return result;
}

function isValidAnswerScore(value: unknown): value is number {
    return (
        typeof value === "number" &&
        Number.isInteger(value) &&
        value >= MIN_ANSWER_SCORE &&
        value <= MAX_ANSWER_SCORE
    );
}
