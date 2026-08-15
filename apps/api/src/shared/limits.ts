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

/**
 * Máximo de detecciones de riesgos y lagunas por candidato (§13). Mismo
 * criterio que las regeneraciones de análisis: se cuenta en app_event.
 */
export const MAX_RISK_DETECTIONS_PER_CANDIDATE = 5;

// ── Entrevista asistida por audio (§24) ─────────────────────────────────────

/** Tamaño máximo de cada pista de audio subida, en megabytes. */
export const MAX_INTERVIEW_AUDIO_MB = 25;

/**
 * Máximo de caracteres de transcripción fusionada (~2 h de entrevista). Pasado
 * ese punto el análisis se rechaza ANTES de gastar una sola llamada al modelo.
 */
export const MAX_TRANSCRIPT_CHARS = 120_000;

/** Tope de fragmentos: acota el número de llamadas al modelo de la etapa 1. */
export const MAX_TRANSCRIPT_CHUNKS = 24;

/** Tamaño objetivo de cada fragmento de transcripción, en caracteres. */
export const CHUNK_TARGET_CHARS = 4_500;

/** Duración máxima de un fragmento. Manda el que se alcance antes. */
export const CHUNK_MAX_SECONDS = 240;

/**
 * Solape entre fragmentos consecutivos: una respuesta a caballo del corte
 * aparece entera al menos en uno de los dos.
 */
export const CHUNK_OVERLAP_SECONDS = 20;

/** Caracteres máximos de fragmentos que se mandan al evaluar UNA pregunta. */
export const MAX_EXCERPT_CHARS = 12_000;

/** Citas que respaldan una propuesta. Más de tres no se leen. */
export const MAX_QUOTES_PER_PROPOSAL = 3;

/**
 * Longitud máxima de cada cita. Las citas son la transcripción literal que
 * viaja en las propuestas y sale por la API, así que se mantiene corta a
 * propósito (§17).
 */
export const MAX_QUOTE_CHARS = 300;

/**
 * Grabaciones conservadas por candidato (§24, 2026-08-10). Existe para acotar
 * el disco: cada una son hasta 50 MB entre las dos pistas. Al llegar al tope
 * se RECHAZA en vez de rotar la más antigua — borrar una grabación es una
 * decisión del evaluador, no un efecto secundario de subir otra.
 */
export const MAX_RECORDINGS_PER_CANDIDATE = 5;

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
    /**
     * Análisis de audio de entrevista. Muy por debajo del resto: cada uno son
     * ~15 minutos de CPU entre transcripción y modelo.
     */
    INTERVIEW: 6,
    /** Detección de riesgos y lagunas (una llamada al modelo por candidato). */
    RISKS: 30,
} as const;

export type RateLimitedAction = keyof typeof RATE_LIMITS_PER_HOUR;
