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

/**
 * Máximo de exportaciones por sesión. Desde el 2026-08-15 "sesión" es una
 * ventana deslizante de una hora (`export-session.ts`), no la vida del proceso
 * de la API: antes, a la undécima exportación había que reiniciar el servidor.
 */
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

/**
 * Candidatos por comparación (vista Comparativa, §15/§21). Acota el prompt de
 * `compare-candidates` al presupuesto de contexto del modelo local y, sobre
 * todo, a lo que un modelo de 2B puede contrastar de una vez con criterio.
 * Comparar a más se hace en tandas.
 */
export const MAX_COMPARISON_CANDIDATES = 5;

/**
 * Análisis de entrevista que pueden esperar en cola detrás del que está
 * corriendo (§24, 2026-08-15). Sigue habiendo UNO ejecutándose a la vez —el
 * modelo y whisper no van más rápido por repartirse— pero el segundo ya no se
 * rechaza: espera su turno y la pantalla se puede cerrar mientras tanto. El
 * tope existe porque un análisis son ~15 min y a partir de aquí la espera es
 * mayor que volver más tarde; el rate limit horario acota lo que entra.
 */
export const MAX_QUEUED_INTERVIEW_ANALYSES = 5;

/** Ventana de rate limiting local: una hora, en milisegundos. */
export const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;

/** Límites por hora para cada acción costosa (BLUEPRINT §16). */
export const RATE_LIMITS_PER_HOUR = {
    /**
     * Extracción de texto de CV. Se mantiene en 100/h para que un proceso
     * completo quepa en una carga masiva; cada CV cuenta uno, suelto o en lote.
     * El límite anterior de 20/h hacía que un único lote agotara el cupo.
     */
    EXTRACT: 100,
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
    /**
     * Comparación cualitativa de candidatos con el modelo. Cada una es un
     * prompt con hasta MAX_COMPARISON_CANDIDATES análisis completos y no se
     * persiste, así que se acota más que el análisis individual.
     */
    COMPARE: 20,
    /** Detección de riesgos y lagunas (una llamada al modelo por candidato). */
    RISKS: 30,
    /**
     * Reanálisis desde una transcripción ya guardada (§24, 2026-08-15). Se
     * salta whisper —la parte cara— y son solo llamadas al modelo, ~1-2 min:
     * cobrarlo contra el cupo de 6 dejaba sin sitio a quien reintentaba tras
     * un fallo del modelo o quería reevaluar con las preguntas nuevas.
     */
    INTERVIEW_REANALYSIS: 20,
} as const;

export type RateLimitedAction = keyof typeof RATE_LIMITS_PER_HOUR;

// ── Carga masiva de CVs (§16, 2026-08-15) ───────────────────────────────────

/**
 * Archivos por lote en la carga masiva de CVs. Acota la RAM del request: los
 * CVs se reciben en memoria (nunca en disco) y en el peor caso son 30 × 10 MB.
 * Un lote más grande se rechaza entero antes de crear nada; se sube en dos
 * veces.
 */
export const MAX_BULK_CV_FILES = 30;
