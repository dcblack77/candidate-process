/**
 * Límites operativos del sistema (BLUEPRINT §16).
 * Única fuente de verdad: no duplicar estos valores en otros módulos.
 */

/** Tamaño máximo de un CV subido, en megabytes. */
export const MAX_CV_MB = 10;

/** Máximo de caracteres de texto extraído por CV. */
export const MAX_EXTRACTED_CHARS = 50_000;

/** Máximo de candidatos por proceso. */
export const MAX_CANDIDATES_PER_PROCESS = 100;

/** Máximo de regeneraciones de análisis por candidato. */
export const MAX_ANALYSIS_REGENERATIONS = 5;

/** Máximo de preguntas de entrevista por candidato. */
export const MAX_QUESTIONS_PER_CANDIDATE = 20;

/** Máximo de exportaciones por sesión. */
export const MAX_EXPORTS_PER_SESSION = 10;

/** Ventana de rate limiting local: una hora, en milisegundos. */
export const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;

/** Límites por hora para cada acción costosa (BLUEPRINT §16). */
export const RATE_LIMITS_PER_HOUR = {
    /** Extracción de texto de CV. */
    EXTRACT: 20,
    /** Análisis con el modelo local. */
    ANALYZE: 30,
    /** Generación de preguntas. */
    QUESTIONS: 60,
    /** Regeneración de ranking. */
    RANKING: 30,
} as const;

export type RateLimitedAction = keyof typeof RATE_LIMITS_PER_HOUR;
