import { z } from "zod";
import {
    CRITERIA,
    evidenceItemJsonSchema,
    evidenceItemZodSchema,
    MAX_LIST_ITEM_LENGTH,
    MAX_LIST_ITEMS,
} from "./common";

/**
 * Salida estructurada de `prompts/detect-risks-and-gaps.md` (BLUEPRINT §13 y
 * §18): riesgos y lagunas de un candidato que hay que llevar a la entrevista.
 *
 * Dos listas deliberadamente separadas (regla dura 3 del prompt):
 *
 * - `risks`: algo que el resumen del CV SÍ dice y que preocupa. Cada uno
 *   lleva su `evidence {text, type}`: qué parte del resumen lo sostiene y si
 *   es un dato explícito o una deducción. El backend verifica los `explicit`
 *   contra el resumen (risks/risk-verifier.ts) y rebaja a `inferred` los que
 *   no encuentra: un riesgo inventado es peor que no reportarlo.
 * - `gaps`: algo que el resumen NO permite saber. No es un riesgo, es falta
 *   de información; por eso no lleva evidencia ni severidad, solo qué falta,
 *   por qué importa y cómo despejarlo.
 *
 * Ambas listas son MATERIAL PARA PREGUNTAR, no una conclusión: `interview_check`
 * es obligatorio en cada ítem. El modelo no calcula ningún score aquí.
 */

/** Familias de riesgo del prompt ("Qué buscar"). Mismos nombres en la UI. */
export const RISK_CATEGORIES = [
    "role_gap",
    "exposure_without_results",
    "unproven_transition",
    "no_production_experience",
    "timeline_inconsistency",
    "single_environment",
    "vague_claim",
] as const;

export type RiskCategory = (typeof RISK_CATEGORIES)[number];

/** Gravedad orientativa: cuánto pesaría el riesgo si se confirmara. */
export const RISK_SEVERITIES = ["low", "medium", "high"] as const;

export type RiskSeverity = (typeof RISK_SEVERITIES)[number];

/** Longitud máxima de cada campo de texto de un riesgo o laguna. */
export const MAX_RISK_TEXT_LENGTH = MAX_LIST_ITEM_LENGTH;

/** Máximo de riesgos y de lagunas por análisis (cada lista por separado). */
export const MAX_RISK_ITEMS = MAX_LIST_ITEMS;

const riskItemJsonSchema = {
    type: "object",
    additionalProperties: false,
    required: [
        "category",
        "criterion",
        "severity",
        "concern",
        "evidence",
        "interview_check",
    ],
    properties: {
        category: { type: "string", enum: [...RISK_CATEGORIES] },
        criterion: { type: "string", enum: [...CRITERIA] },
        severity: { type: "string", enum: [...RISK_SEVERITIES] },
        concern: { type: "string", maxLength: MAX_RISK_TEXT_LENGTH },
        evidence: evidenceItemJsonSchema,
        interview_check: { type: "string", maxLength: MAX_RISK_TEXT_LENGTH },
    },
} as const;

const gapItemJsonSchema = {
    type: "object",
    additionalProperties: false,
    required: ["criterion", "missing", "why_it_matters", "interview_check"],
    properties: {
        criterion: { type: "string", enum: [...CRITERIA] },
        missing: { type: "string", maxLength: MAX_RISK_TEXT_LENGTH },
        why_it_matters: { type: "string", maxLength: MAX_RISK_TEXT_LENGTH },
        interview_check: { type: "string", maxLength: MAX_RISK_TEXT_LENGTH },
    },
} as const;

/** JSON Schema enviado a llama.cpp para detect-risks-and-gaps. */
export const DETECT_RISKS_JSON_SCHEMA = {
    type: "object",
    additionalProperties: false,
    required: ["risks", "gaps", "confidence"],
    properties: {
        risks: {
            type: "array",
            maxItems: MAX_RISK_ITEMS,
            items: riskItemJsonSchema,
        },
        gaps: {
            type: "array",
            maxItems: MAX_RISK_ITEMS,
            items: gapItemJsonSchema,
        },
        confidence: { type: "number", minimum: 0, maximum: 1 },
    },
} as const;

const riskItemZodSchema = z
    .object({
        category: z.enum(RISK_CATEGORIES),
        criterion: z.enum(CRITERIA),
        severity: z.enum(RISK_SEVERITIES),
        concern: z.string().max(MAX_RISK_TEXT_LENGTH),
        evidence: evidenceItemZodSchema,
        interview_check: z.string().max(MAX_RISK_TEXT_LENGTH),
    })
    .strict();

const gapItemZodSchema = z
    .object({
        criterion: z.enum(CRITERIA),
        missing: z.string().max(MAX_RISK_TEXT_LENGTH),
        why_it_matters: z.string().max(MAX_RISK_TEXT_LENGTH),
        interview_check: z.string().max(MAX_RISK_TEXT_LENGTH),
    })
    .strict();

/** Schema zod espejo de {@link DETECT_RISKS_JSON_SCHEMA}. */
export const detectRisksZodSchema = z
    .object({
        risks: z.array(riskItemZodSchema).max(MAX_RISK_ITEMS),
        gaps: z.array(gapItemZodSchema).max(MAX_RISK_ITEMS),
        confidence: z.number().min(0).max(1),
    })
    .strict();

export type DetectRisksResult = z.infer<typeof detectRisksZodSchema>;
export type RiskItem = z.infer<typeof riskItemZodSchema>;
export type GapItem = z.infer<typeof gapItemZodSchema>;
