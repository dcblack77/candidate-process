import { z } from "zod";
import { CRITERIA } from "./common";

/**
 * Salida estructurada de `prompts/generate-questions.md` (BLUEPRINT §07 y §14).
 *
 * Cada pregunta lleva SIEMPRE el bloque completo de §14: pregunta, dimensión,
 * criterio, qué valida, respuesta ideal, señales positivas, señales de alerta
 * y guía de puntuación (1/3/5).
 */

/** Dimensiones de entrevista (§07). Valores en español, como en la DB. */
export const QUESTION_DIMENSIONS = [
    "velocidad",
    "profundidad_vs_exposicion",
    "contribucion",
    "aprendizaje",
    "investigacion",
    "operacion",
] as const;

export type QuestionDimension = (typeof QUESTION_DIMENSIONS)[number];

/** Máximo de preguntas por candidato (§16). */
export const MAX_QUESTIONS = 20;

export const MAX_QUESTION_LENGTH = 500;
export const MAX_VALIDATES_LENGTH = 300;
export const MAX_IDEAL_ANSWER_LENGTH = 800;
export const MAX_SIGNAL_LENGTH = 200;
export const MAX_SIGNALS = 5;
export const MAX_SCORING_GUIDANCE_LENGTH = 500;

const questionJsonSchema = {
    type: "object",
    additionalProperties: false,
    required: [
        "question",
        "dimension",
        "criterion",
        "validates",
        "ideal_answer",
        "positive_signals",
        "warning_signals",
        "scoring_guidance",
    ],
    properties: {
        question: { type: "string", maxLength: MAX_QUESTION_LENGTH },
        dimension: { type: "string", enum: [...QUESTION_DIMENSIONS] },
        criterion: { type: "string", enum: [...CRITERIA] },
        validates: { type: "string", maxLength: MAX_VALIDATES_LENGTH },
        ideal_answer: { type: "string", maxLength: MAX_IDEAL_ANSWER_LENGTH },
        positive_signals: {
            type: "array",
            minItems: 1,
            maxItems: MAX_SIGNALS,
            items: { type: "string", maxLength: MAX_SIGNAL_LENGTH },
        },
        warning_signals: {
            type: "array",
            minItems: 1,
            maxItems: MAX_SIGNALS,
            items: { type: "string", maxLength: MAX_SIGNAL_LENGTH },
        },
        scoring_guidance: {
            type: "string",
            maxLength: MAX_SCORING_GUIDANCE_LENGTH,
        },
    },
} as const;

/** JSON Schema enviado a llama.cpp para generate-questions. */
export const GENERATE_QUESTIONS_JSON_SCHEMA = {
    type: "object",
    additionalProperties: false,
    required: ["questions"],
    properties: {
        questions: {
            type: "array",
            minItems: 1,
            maxItems: MAX_QUESTIONS,
            items: questionJsonSchema,
        },
    },
} as const;

const signalsZodSchema = z
    .array(z.string().max(MAX_SIGNAL_LENGTH))
    .min(1)
    .max(MAX_SIGNALS);

const questionZodSchema = z
    .object({
        question: z.string().max(MAX_QUESTION_LENGTH),
        dimension: z.enum(QUESTION_DIMENSIONS),
        criterion: z.enum(CRITERIA),
        validates: z.string().max(MAX_VALIDATES_LENGTH),
        ideal_answer: z.string().max(MAX_IDEAL_ANSWER_LENGTH),
        positive_signals: signalsZodSchema,
        warning_signals: signalsZodSchema,
        scoring_guidance: z.string().max(MAX_SCORING_GUIDANCE_LENGTH),
    })
    .strict();

/** Schema zod espejo de {@link GENERATE_QUESTIONS_JSON_SCHEMA}. */
export const generateQuestionsZodSchema = z
    .object({
        questions: z.array(questionZodSchema).min(1).max(MAX_QUESTIONS),
    })
    .strict();

export type GenerateQuestionsResult = z.infer<
    typeof generateQuestionsZodSchema
>;
export type GeneratedQuestion = z.infer<typeof questionZodSchema>;
