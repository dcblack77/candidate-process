import { z } from "zod";
import {
    CRITERIA,
    evidenceItemJsonSchema,
    evidenceItemZodSchema,
    MAX_EVIDENCE_ITEMS,
    shortStringListJsonSchema,
    shortStringListZodSchema,
} from "./common";

/**
 * Salida estructurada de `prompts/summarize-cv.md` (BLUEPRINT §13).
 *
 * `{professional_summary, evidence{criterio: [{text, type}]}, technology_transitions,
 *  doubts_for_interview, risks}` — sin puntuaciones: puntuar es de score-candidate.
 */

export const MAX_PROFESSIONAL_SUMMARY_LENGTH = 1500;

const evidenceArrayJsonSchema = {
    type: "array",
    maxItems: MAX_EVIDENCE_ITEMS,
    items: evidenceItemJsonSchema,
} as const;

/** JSON Schema enviado a llama.cpp para summarize-cv. */
export const SUMMARIZE_CV_JSON_SCHEMA = {
    type: "object",
    additionalProperties: false,
    required: [
        "professional_summary",
        "evidence",
        "technology_transitions",
        "doubts_for_interview",
        "risks",
    ],
    properties: {
        professional_summary: {
            type: "string",
            maxLength: MAX_PROFESSIONAL_SUMMARY_LENGTH,
        },
        evidence: {
            type: "object",
            additionalProperties: false,
            required: [...CRITERIA],
            properties: {
                adaptability: evidenceArrayJsonSchema,
                fundamentals: evidenceArrayJsonSchema,
                depth: evidenceArrayJsonSchema,
                production: evidenceArrayJsonSchema,
                stack: evidenceArrayJsonSchema,
            },
        },
        technology_transitions: shortStringListJsonSchema,
        doubts_for_interview: shortStringListJsonSchema,
        risks: shortStringListJsonSchema,
    },
} as const;

const evidenceArrayZodSchema = z
    .array(evidenceItemZodSchema)
    .max(MAX_EVIDENCE_ITEMS);

/** Schema zod espejo de {@link SUMMARIZE_CV_JSON_SCHEMA}. */
export const summarizeCvZodSchema = z
    .object({
        professional_summary: z.string().max(MAX_PROFESSIONAL_SUMMARY_LENGTH),
        evidence: z
            .object({
                adaptability: evidenceArrayZodSchema,
                fundamentals: evidenceArrayZodSchema,
                depth: evidenceArrayZodSchema,
                production: evidenceArrayZodSchema,
                stack: evidenceArrayZodSchema,
            })
            .strict(),
        technology_transitions: shortStringListZodSchema,
        doubts_for_interview: shortStringListZodSchema,
        risks: shortStringListZodSchema,
    })
    .strict();

export type SummarizeCvResult = z.infer<typeof summarizeCvZodSchema>;
