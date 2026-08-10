import { z } from "zod";
import { CRITERIA } from "./common";

/**
 * Salida estructurada de `prompts/generate-questions.md` (BLUEPRINT §07 y §14).
 *
 * Cada pregunta lleva el bloque de §14: pregunta, dimensión, criterio,
 * respuesta ideal, señales positivas, señales de alerta y guía de puntuación
 * (1/3/5).
 *
 * Brevedad (decisión del 2026-08-07): el bloque se lee en voz alta durante la
 * entrevista, así que se recortaron los máximos. Estos límites son un TECHO
 * con holgura, no el objetivo: quien marca la longitud real es el prompt, que
 * pide bastante menos. La holgura es deliberada — el schema se traduce a
 * gramática en llama.cpp y un tope pegado al objetivo convertiría cualquier
 * frase larga en un reintento (y, agotados, en LLM_UNAVAILABLE).
 *
 * `validates` ("qué busca validar esta pregunta") se retiró en esa misma
 * decisión: repetía lo que ya dicen la pregunta, el criterio y la dimensión.
 * La columna sigue en la base y en el DTO porque las preguntas generadas
 * antes conservan su texto; lo que ya no se hace es pedirla al modelo.
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

/** Una sola pregunta, ~2 líneas. El prompt pide ~200. */
export const MAX_QUESTION_LENGTH = 300;
/** Qué debe aparecer en una buena respuesta, en 2-3 frases. Prompt: ~300. */
export const MAX_IDEAL_ANSWER_LENGTH = 450;
/** Cada señal es una frase suelta de una línea. Prompt: ~100. */
export const MAX_SIGNAL_LENGTH = 140;
/** El prompt pide exactamente 3; el cuarto hueco es holgura. */
export const MAX_SIGNALS = 4;
/** Una frase por nivel 1/3/5. Prompt: ~200 en total. */
export const MAX_SCORING_GUIDANCE_LENGTH = 300;

const questionJsonSchema = {
    type: "object",
    additionalProperties: false,
    required: [
        "question",
        "dimension",
        "criterion",
        "ideal_answer",
        "positive_signals",
        "warning_signals",
        "scoring_guidance",
    ],
    properties: {
        question: { type: "string", maxLength: MAX_QUESTION_LENGTH },
        dimension: { type: "string", enum: [...QUESTION_DIMENSIONS] },
        criterion: { type: "string", enum: [...CRITERIA] },
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
