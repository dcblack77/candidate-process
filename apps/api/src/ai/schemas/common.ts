import { z } from "zod";

/**
 * Piezas compartidas por los schemas de salida del modelo (plan §Salidas
 * estructuradas). Cada salida se define dos veces, de forma espejo:
 *
 * - JSON Schema (constante TS): se envía a llama.cpp en
 *   `response_format.json_schema` para que la gramática restrinja la salida.
 * - Schema zod: valida en runtime lo que el modelo devolvió y produce el
 *   tipo TS inferido que consume el resto del backend.
 *
 * Regla transversal: `additionalProperties: false` en todos los objetos.
 * El modelo NUNCA calcula `final_score` (eso es de scoring/weights.ts) y por
 * eso ningún schema tiene ese campo.
 */

/** Los cinco criterios de la rúbrica (§06). Mismos nombres que en DB. */
export const CRITERIA = [
    "adaptability",
    "fundamentals",
    "depth",
    "production",
    "stack",
] as const;

export type Criterion = (typeof CRITERIA)[number];

/** Tipos de evidencia (§13): explícita en el CV o inferida por el modelo. */
export const EVIDENCE_TYPES = ["explicit", "inferred"] as const;

/** Longitudes máximas comunes (plan §Salidas estructuradas). */
export const MAX_EVIDENCE_TEXT_LENGTH = 300;
export const MAX_EVIDENCE_ITEMS = 8;
export const MAX_LIST_ITEM_LENGTH = 300;
export const MAX_LIST_ITEMS = 10;

/** JSON Schema de un ítem de evidencia `{text, type}`. */
export const evidenceItemJsonSchema = {
    type: "object",
    additionalProperties: false,
    required: ["text", "type"],
    properties: {
        text: { type: "string", maxLength: MAX_EVIDENCE_TEXT_LENGTH },
        type: { type: "string", enum: [...EVIDENCE_TYPES] },
    },
} as const;

/** Schema zod espejo de {@link evidenceItemJsonSchema}. */
export const evidenceItemZodSchema = z
    .object({
        text: z.string().max(MAX_EVIDENCE_TEXT_LENGTH),
        type: z.enum(EVIDENCE_TYPES),
    })
    .strict();

export type EvidenceItem = z.infer<typeof evidenceItemZodSchema>;

/** JSON Schema de una lista corta de strings (dudas, riesgos, transiciones…). */
export const shortStringListJsonSchema = {
    type: "array",
    maxItems: MAX_LIST_ITEMS,
    items: { type: "string", maxLength: MAX_LIST_ITEM_LENGTH },
} as const;

/** Schema zod espejo de {@link shortStringListJsonSchema}. */
export const shortStringListZodSchema = z
    .array(z.string().max(MAX_LIST_ITEM_LENGTH))
    .max(MAX_LIST_ITEMS);
