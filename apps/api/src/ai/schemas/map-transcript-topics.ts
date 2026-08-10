import { z } from "zod";

/**
 * Salida estructurada de `prompts/map-transcript-topics.md` — etapa 1 del
 * análisis de entrevista (BLUEPRINT §24).
 *
 * Tarea: dado UN fragmento de transcripción y el índice de preguntas, decir
 * cuáles de esos temas aparecen. Es clasificación gruesa sobre un contexto
 * corto, que es lo que un modelo de 2B hace decentemente; pedirle que mapee
 * 20 preguntas contra la entrevista entera de una tacada, no.
 *
 * El schema se construye por fábrica porque depende del número de preguntas
 * del candidato.
 */

/** Cuánto peso tiene el tema dentro del fragmento. */
export const TOPIC_RELEVANCE = ["central", "tangencial"] as const;
export type TopicRelevance = (typeof TOPIC_RELEVANCE)[number];

/** Máximo de coincidencias por fragmento: más no se usan aguas abajo. */
export const MAX_TOPIC_MATCHES = 12;

/** Longitud máxima de la cita que respalda una coincidencia. */
export const MAX_TOPIC_QUOTE_LENGTH = 220;

/**
 * Referencia de pregunta tal y como se numera en el prompt: `P1`, `P2`, …
 * Se usan strings y un `enum` en vez de un entero acotado a propósito: los
 * enums se traducen a alternativas de gramática GBNF de forma fiable en
 * llama.cpp, mientras que `minimum`/`maximum` sobre enteros dependen de la
 * implementación y el modelo puede devolver un índice fuera de rango.
 */
export function questionRef(index: number): string {
    return `P${index + 1}`;
}

/** Índice (0-based) a partir de una referencia `P<n>`; -1 si no es válida. */
export function refToIndex(ref: string): number {
    const match = /^P(\d+)$/.exec(ref);
    if (!match) {
        return -1;
    }
    return Number(match[1]) - 1;
}

/** JSON Schema para la gramática de llama.cpp, dado el juego de referencias. */
export function buildTranscriptTopicsJsonSchema(
    refs: string[],
): Record<string, unknown> {
    return {
        type: "object",
        additionalProperties: false,
        required: ["matches"],
        properties: {
            matches: {
                type: "array",
                maxItems: MAX_TOPIC_MATCHES,
                items: {
                    type: "object",
                    additionalProperties: false,
                    required: ["question_ref", "relevance", "quote"],
                    properties: {
                        question_ref: { type: "string", enum: [...refs] },
                        relevance: {
                            type: "string",
                            enum: [...TOPIC_RELEVANCE],
                        },
                        quote: {
                            type: "string",
                            maxLength: MAX_TOPIC_QUOTE_LENGTH,
                        },
                    },
                },
            },
        },
    };
}

export interface TopicMatch {
    question_ref: string;
    relevance: TopicRelevance;
    quote: string;
}

export interface TranscriptTopicsResult {
    matches: TopicMatch[];
}

/** Schema zod espejo. Rechaza referencias a preguntas que no existen. */
export function buildTranscriptTopicsZodSchema(
    refs: string[],
): z.ZodType<TranscriptTopicsResult, z.ZodTypeDef, unknown> {
    const refSchema =
        refs.length > 0
            ? z.enum(refs as [string, ...string[]])
            : z.never({
                  errorMap: () => ({
                      message: "No hay preguntas a las que enrutar.",
                  }),
              });

    return z
        .object({
            matches: z
                .array(
                    z
                        .object({
                            question_ref: refSchema,
                            relevance: z.enum(TOPIC_RELEVANCE),
                            quote: z.string().max(MAX_TOPIC_QUOTE_LENGTH),
                        })
                        .strict(),
                )
                .max(MAX_TOPIC_MATCHES),
        })
        .strict() as z.ZodType<TranscriptTopicsResult, z.ZodTypeDef, unknown>;
}
