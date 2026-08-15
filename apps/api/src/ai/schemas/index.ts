/**
 * Barrel de los schemas de salida estructurada del modelo local.
 * Cada schema existe en dos formas espejo: JSON Schema (para la gramática de
 * llama.cpp) y zod (validación runtime + tipo TS inferido).
 */
export * from "./common";
export * from "./summarize-cv";
export * from "./score-candidate";
export * from "./generate-questions";
export * from "./compare-candidates";
