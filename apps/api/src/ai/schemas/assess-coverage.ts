import { z } from "zod";
import { COVERAGE_LEVELS } from "../../interview/interview.dto";
import { MAX_QUOTES_PER_PROPOSAL } from "../../shared/limits";

/**
 * Salida estructurada de `prompts/assess-question-coverage.md` — etapa 2 del
 * análisis de entrevista (BLUEPRINT §24).
 *
 * Tarea: dada UNA pregunta con su bloque completo y 1-3 fragmentos de
 * transcripción, decidir hasta qué punto el candidato abordó el tema y
 * proponer una nota.
 *
 * Solo CINCO campos: cada campo extra degrada de forma apreciable a un modelo
 * de 2B, y aquí importa más acertar el nivel de cobertura que recoger matices.
 *
 * Los `maxLength` son un TECHO con holgura sobre lo que pide el prompt (600 y
 * 300), misma decisión que en `generate-questions`: un tope pegado al objetivo
 * convierte cualquier frase larga en un reintento.
 */

export const MAX_PROPOSED_NOTES_LENGTH = 700;
export const MAX_ASSESS_QUOTE_LENGTH = 340;

/** Nota mínima y máxima propuesta, en la misma escala 1-10 que `answer_score`. */
export const MIN_PROPOSED_SCORE = 1;
export const MAX_PROPOSED_SCORE = 10;

/**
 * `proposed_score` se pide OBLIGATORIO y no nulable: la nulabilidad en
 * gramáticas de llama.cpp es frágil y el modelo acaba emitiendo `"null"` como
 * texto o rompiendo el JSON. El modelo siempre da un número y es el código
 * (`quote-verifier.ts`) el que lo anula cuando la cobertura no lo justifica.
 */
export const ASSESS_COVERAGE_JSON_SCHEMA = {
    type: "object",
    additionalProperties: false,
    required: [
        "coverage",
        "proposed_score",
        "proposed_notes",
        "evidence",
        "confidence",
    ],
    properties: {
        coverage: { type: "string", enum: [...COVERAGE_LEVELS] },
        proposed_score: {
            type: "integer",
            minimum: MIN_PROPOSED_SCORE,
            maximum: MAX_PROPOSED_SCORE,
        },
        proposed_notes: {
            type: "string",
            maxLength: MAX_PROPOSED_NOTES_LENGTH,
        },
        evidence: {
            type: "array",
            maxItems: MAX_QUOTES_PER_PROPOSAL,
            items: {
                type: "object",
                additionalProperties: false,
                required: ["quote"],
                properties: {
                    quote: {
                        type: "string",
                        maxLength: MAX_ASSESS_QUOTE_LENGTH,
                    },
                },
            },
        },
        confidence: { type: "number", minimum: 0, maximum: 1 },
    },
} as const;

const assessCoverageZod = z
    .object({
        coverage: z.enum(COVERAGE_LEVELS),
        proposed_score: z
            .number()
            .int()
            .min(MIN_PROPOSED_SCORE)
            .max(MAX_PROPOSED_SCORE),
        proposed_notes: z.string().max(MAX_PROPOSED_NOTES_LENGTH),
        evidence: z
            .array(
                z
                    .object({ quote: z.string().max(MAX_ASSESS_QUOTE_LENGTH) })
                    .strict(),
            )
            .max(MAX_QUOTES_PER_PROPOSAL),
        confidence: z.number().min(0).max(1),
    })
    .strict();

/** Schema zod espejo de {@link ASSESS_COVERAGE_JSON_SCHEMA}. */
export const assessCoverageZodSchema = assessCoverageZod;

export type AssessCoverageResult = z.infer<typeof assessCoverageZod>;
