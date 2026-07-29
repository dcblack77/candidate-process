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
 * Salida estructurada de `prompts/score-candidate.md` (BLUEPRINT §06 y §13).
 *
 * `{scores{criterio: {score 1-5, rationale, evidence[]}}, confidence 0-1,
 *  doubts, risks}`.
 *
 * IMPORTANTE: el modelo NO calcula el score final ponderado. Ese cálculo vive
 * únicamente en scoring/weights.ts; por eso este schema no tiene `final_score`
 * y `additionalProperties: false` impide que el modelo lo añada.
 */

export const MAX_RATIONALE_LENGTH = 400;

const criterionScoreJsonSchema = {
    type: "object",
    additionalProperties: false,
    required: ["score", "rationale", "evidence"],
    properties: {
        score: { type: "integer", minimum: 1, maximum: 5 },
        rationale: { type: "string", maxLength: MAX_RATIONALE_LENGTH },
        evidence: {
            type: "array",
            maxItems: MAX_EVIDENCE_ITEMS,
            items: evidenceItemJsonSchema,
        },
    },
} as const;

/** JSON Schema enviado a llama.cpp para score-candidate. */
export const SCORE_CANDIDATE_JSON_SCHEMA = {
    type: "object",
    additionalProperties: false,
    required: ["scores", "confidence", "doubts", "risks"],
    properties: {
        scores: {
            type: "object",
            additionalProperties: false,
            required: [...CRITERIA],
            properties: {
                adaptability: criterionScoreJsonSchema,
                fundamentals: criterionScoreJsonSchema,
                depth: criterionScoreJsonSchema,
                production: criterionScoreJsonSchema,
                stack: criterionScoreJsonSchema,
            },
        },
        confidence: { type: "number", minimum: 0, maximum: 1 },
        doubts: shortStringListJsonSchema,
        risks: shortStringListJsonSchema,
    },
} as const;

const criterionScoreZodSchema = z
    .object({
        score: z.number().int().min(1).max(5),
        rationale: z.string().max(MAX_RATIONALE_LENGTH),
        evidence: z.array(evidenceItemZodSchema).max(MAX_EVIDENCE_ITEMS),
    })
    .strict();

/** Schema zod espejo de {@link SCORE_CANDIDATE_JSON_SCHEMA}. */
export const scoreCandidateZodSchema = z
    .object({
        scores: z
            .object({
                adaptability: criterionScoreZodSchema,
                fundamentals: criterionScoreZodSchema,
                depth: criterionScoreZodSchema,
                production: criterionScoreZodSchema,
                stack: criterionScoreZodSchema,
            })
            .strict(),
        confidence: z.number().min(0).max(1),
        doubts: shortStringListZodSchema,
        risks: shortStringListZodSchema,
    })
    .strict();

export type ScoreCandidateResult = z.infer<typeof scoreCandidateZodSchema>;
export type CriterionScore = z.infer<typeof criterionScoreZodSchema>;
