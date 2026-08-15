import { z } from "zod";
import { CRITERIA } from "./common";

/**
 * Salida estructurada de `prompts/compare-candidates.md` (BLUEPRINT §15, §18
 * y §21 — vista Comparativa).
 *
 * `{criteria{criterio: {leaders[], analysis}}, evidence_quality, profiles,
 *  ties[{candidates[], what_would_separate}], open_questions[], summary}`.
 *
 * A diferencia del resto de schemas, este se CONSTRUYE POR PETICIÓN
 * ({@link buildCompareCandidatesSchemas}): la lista de referencias de los
 * candidatos comparados (`C1`, `C2`, …) entra como `enum` en el JSON Schema.
 * Así la gramática de llama.cpp impide que el modelo señale a un candidato
 * que no está en la comparación o se invente uno, y el backend puede resolver
 * cada referencia a su `candidateId` sin heurísticas sobre nombres (dos
 * candidatos pueden llamarse igual; un 2B copiando UUIDs se equivoca).
 *
 * El modelo NO devuelve puntuaciones: compara las que recibe. Por eso no hay
 * ningún campo numérico y `additionalProperties: false` impide añadirlos.
 */

/** Prefijo de las referencias cortas con las que el modelo señala candidatos. */
export const CANDIDATE_REF_PREFIX = "C";

/** Longitudes máximas de los textos de la comparación. */
export const MAX_CRITERION_ANALYSIS_LENGTH = 500;
export const MAX_COMPARISON_TEXT_LENGTH = 600;
export const MAX_TIE_SEPARATOR_LENGTH = 300;
export const MAX_OPEN_QUESTION_LENGTH = 300;

/** Topes de las listas: más de esto no se lee en una comparativa. */
export const MAX_TIES = 5;
export const MAX_OPEN_QUESTIONS = 8;

/** Referencia corta del candidato en posición `index` (0-based): C1, C2… */
export function candidateRef(index: number): string {
    return `${CANDIDATE_REF_PREFIX}${index + 1}`;
}

/** Comparación por criterio: quién destaca (0..n referencias) y por qué. */
export interface CriterionComparison {
    leaders: string[];
    analysis: string;
}

/** Empate práctico entre dos o más candidatos y qué los separaría. */
export interface ComparisonTie {
    candidates: string[];
    what_would_separate: string;
}

/** Resultado validado de compare-candidates (referencias sin resolver). */
export interface CompareCandidatesResult {
    criteria: Record<(typeof CRITERIA)[number], CriterionComparison>;
    evidence_quality: string;
    profiles: string;
    ties: ComparisonTie[];
    open_questions: string[];
    summary: string;
}

/** Par de schemas espejo (JSON Schema para la gramática + zod para validar). */
export interface CompareCandidatesSchemas {
    jsonSchema: Record<string, unknown>;
    zodSchema: z.ZodType<CompareCandidatesResult, z.ZodTypeDef, unknown>;
}

/**
 * Construye los schemas para una comparación entre `refs` (≥ 2 referencias
 * distintas, normalmente `C1..Cn` de {@link candidateRef}).
 *
 * En zod, las listas de referencias se DEDUPLICAN en vez de rechazarse: la
 * gramática de llama.cpp no soporta `uniqueItems`, y tirar toda la
 * comparación porque el modelo repitió `C1` en un empate sería castigar una
 * salida perfectamente legible.
 */
export function buildCompareCandidatesSchemas(
    refs: readonly string[],
): CompareCandidatesSchemas {
    const uniqueRefs = [...new Set(refs)];
    if (uniqueRefs.length < 2) {
        throw new Error(
            "compare-candidates requiere al menos dos referencias distintas.",
        );
    }

    const refJsonSchema = { type: "string", enum: uniqueRefs } as const;
    const refListJsonSchema = {
        type: "array",
        maxItems: uniqueRefs.length,
        items: refJsonSchema,
    } as const;
    const criterionJsonSchema = {
        type: "object",
        additionalProperties: false,
        required: ["leaders", "analysis"],
        properties: {
            leaders: refListJsonSchema,
            analysis: { type: "string", maxLength: MAX_CRITERION_ANALYSIS_LENGTH },
        },
    } as const;

    const jsonSchema = {
        type: "object",
        additionalProperties: false,
        required: [
            "criteria",
            "evidence_quality",
            "profiles",
            "ties",
            "open_questions",
            "summary",
        ],
        properties: {
            criteria: {
                type: "object",
                additionalProperties: false,
                required: [...CRITERIA],
                properties: Object.fromEntries(
                    CRITERIA.map((criterion) => [criterion, criterionJsonSchema]),
                ),
            },
            evidence_quality: {
                type: "string",
                maxLength: MAX_COMPARISON_TEXT_LENGTH,
            },
            profiles: { type: "string", maxLength: MAX_COMPARISON_TEXT_LENGTH },
            ties: {
                type: "array",
                maxItems: MAX_TIES,
                items: {
                    type: "object",
                    additionalProperties: false,
                    required: ["candidates", "what_would_separate"],
                    properties: {
                        candidates: {
                            type: "array",
                            minItems: 2,
                            maxItems: uniqueRefs.length,
                            items: refJsonSchema,
                        },
                        what_would_separate: {
                            type: "string",
                            maxLength: MAX_TIE_SEPARATOR_LENGTH,
                        },
                    },
                },
            },
            open_questions: {
                type: "array",
                maxItems: MAX_OPEN_QUESTIONS,
                items: { type: "string", maxLength: MAX_OPEN_QUESTION_LENGTH },
            },
            summary: { type: "string", maxLength: MAX_COMPARISON_TEXT_LENGTH },
        },
    };

    const refZodSchema = z.enum(
        uniqueRefs as [string, ...string[]],
    );
    const refListZodSchema = z
        .array(refZodSchema)
        .max(uniqueRefs.length)
        .transform((list) => [...new Set(list)]);
    const criterionZodSchema = z
        .object({
            leaders: refListZodSchema,
            analysis: z.string().max(MAX_CRITERION_ANALYSIS_LENGTH),
        })
        .strict();

    const zodSchema = z
        .object({
            criteria: z
                .object({
                    adaptability: criterionZodSchema,
                    fundamentals: criterionZodSchema,
                    depth: criterionZodSchema,
                    production: criterionZodSchema,
                    stack: criterionZodSchema,
                })
                .strict(),
            evidence_quality: z.string().max(MAX_COMPARISON_TEXT_LENGTH),
            profiles: z.string().max(MAX_COMPARISON_TEXT_LENGTH),
            ties: z
                .array(
                    z
                        .object({
                            candidates: z
                                .array(refZodSchema)
                                .min(2)
                                .max(uniqueRefs.length)
                                .transform((list) => [...new Set(list)]),
                            what_would_separate: z
                                .string()
                                .max(MAX_TIE_SEPARATOR_LENGTH),
                        })
                        .strict(),
                )
                .max(MAX_TIES)
                // Un "empate" que tras deduplicar se queda con un solo
                // candidato no es un empate: se descarta en silencio en vez
                // de invalidar la comparación entera.
                .transform((ties) =>
                    ties.filter((tie) => tie.candidates.length >= 2),
                ),
            open_questions: z
                .array(z.string().max(MAX_OPEN_QUESTION_LENGTH))
                .max(MAX_OPEN_QUESTIONS),
            summary: z.string().max(MAX_COMPARISON_TEXT_LENGTH),
        })
        .strict();

    return { jsonSchema, zodSchema };
}
