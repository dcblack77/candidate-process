import { Criterion, CRITERIA } from "../ai/schemas/common";

/**
 * ÚNICA FUENTE de los pesos de la rúbrica y del orden de desempate
 * (BLUEPRINT §06 y §15, CLAUDE.md "Rúbrica y ranking").
 *
 * Nadie más define estos valores: el modelo NUNCA calcula el score final
 * (sus aritméticas se ignoran) y el frontend/export los consumen vía la
 * respuesta de GET /ranking.
 */

/** Pesos de la rúbrica (§06). Suman 1. */
export const WEIGHTS: Record<Criterion, number> = {
    adaptability: 0.3,
    fundamentals: 0.25,
    depth: 0.2,
    production: 0.15,
    stack: 0.1,
} as const;

/**
 * Peso del score de CV dentro del score final COMBINADO (§06, segundo nivel).
 * El CV es lo que el candidato promete; pesa menos que lo que demostró.
 */
export const CV_WEIGHT = 0.3;

/** Peso de la nota de entrevista dentro del score final combinado (§06). */
export const INTERVIEW_WEIGHT = 0.7;

/**
 * Divisor que lleva la nota de entrevista (escala 1-10) a la escala 1-5 de
 * la rúbrica antes de combinarla con el score de CV.
 */
export const INTERVIEW_SCALE_DIVISOR = 2;

/**
 * Orden de desempate (§15): adaptabilidad → fundamentos → producción →
 * profundidad → stack → ENTREVISTA → confianza. Si tras confianza persiste
 * el empate, el ranking marca `needsManualReview` (revisión manual).
 *
 * `interview` (nota global de las respuestas de entrevista, 1-10) se inserta
 * entre `stack` y `confidence`: es evidencia observada directamente por el
 * evaluador y, por tanto, más fuerte que la confianza del análisis del CV.
 * Desde el score combinado (§06) la entrevista YA entra en el orden
 * principal; este nivel sigue existiendo porque dos candidatos pueden empatar
 * en el combinado con notas de entrevista distintas (0.3·cv + 0.35·nota).
 */
export const TIE_BREAK_ORDER = [
    "adaptability",
    "fundamentals",
    "production",
    "depth",
    "stack",
    "interview",
    "confidence",
] as const;

export type TieBreakLevel = (typeof TIE_BREAK_ORDER)[number];

/** Puntuaciones 1-5 por criterio. */
export type CriterionScores = Record<Criterion, number>;

/** Redondeo a 2 decimales, sin residuos de coma flotante. */
function round2(value: number): number {
    return Math.round(value * 100) / 100;
}

/**
 * Fórmula de la RÚBRICA (§06, primer nivel): suma ponderada de los cinco
 * criterios, redondeada a 2 decimales. Es el "score de CV" y es lo que se
 * persiste en `candidate_score.final_score`. El backend SIEMPRE recalcula con
 * esta función; cualquier `final_score` que proponga el modelo se descarta.
 */
export function computeFinalScore(scores: CriterionScores): number {
    const sum = CRITERIA.reduce(
        (total, criterion) => total + scores[criterion] * WEIGHTS[criterion],
        0,
    );
    return round2(sum);
}

/** Resultado del score final combinado (§06, segundo nivel). */
export interface OverallScore {
    /** Score final combinado, en la escala 1-5 del CV, a 2 decimales. */
    overall: number;
    /**
     * true cuando el candidato NO tiene ninguna respuesta de entrevista
     * puntuada: el score mostrado es solo el del CV y todavía puede moverse
     * (arriba o abajo) cuando se le puntúe la entrevista.
     */
    provisional: boolean;
}

/**
 * Score final COMBINADO (§06, segundo nivel), DERIVADO: no se persiste.
 *
 * ```text
 * overall = cvScore * 0.30 + (interviewScore / 2) * 0.70
 * ```
 *
 * `interviewScore` es la nota global de entrevista (1-10, ver
 * scoring/interview-score.ts) y se divide por 2 para llevarla a la escala 1-5
 * de la rúbrica, de modo que ambos sumandos son comparables.
 *
 * DECISIÓN (usuario, 2026-07-29): un candidato SIN entrevista puntuada NO se
 * penaliza —su combinado es exactamente su score de CV— pero se marca
 * `provisional: true` para que quede claro que ese número no es definitivo.
 * Penalizarlo escondería a quien aún no ha sido entrevistado; ignorarlo en
 * silencio haría creer que su nota ya está contrastada.
 */
export function computeOverallScore(
    cvScore: number,
    interviewScore: number | null,
): OverallScore {
    if (interviewScore === null) {
        return { overall: round2(cvScore), provisional: true };
    }
    const scaled = interviewScore / INTERVIEW_SCALE_DIVISOR;
    return {
        overall: round2(cvScore * CV_WEIGHT + scaled * INTERVIEW_WEIGHT),
        provisional: false,
    };
}

/** Entrada mínima que necesita el comparador de ranking. */
export interface RankableEntry {
    /** Score de la rúbrica §06 (1-5), el persistido en `final_score`. */
    cvScore: number;
    scores: CriterionScores;
    /**
     * Nota global de entrevista 1-10 (ver scoring/interview-score.ts); null
     * si el candidato no tiene ninguna respuesta puntuada.
     *
     * Entra en el orden principal a través de {@link computeOverallScore}
     * (null ⇒ combinado = score de CV, marcado como provisional) y además
     * sigue siendo un nivel de desempate: ahí null cuenta como 0, es decir,
     * ante un combinado empatado gana quien tiene evidencia de entrevista.
     */
    interviewScore: number | null;
    /** Confianza 0-1 del análisis; null cuenta como 0 en el desempate. */
    confidence: number | null;
}

/** Combinado de una entrada (§06): única vía para ordenar el ranking. */
function overallOf(entry: RankableEntry): number {
    return computeOverallScore(entry.cvScore, entry.interviewScore).overall;
}

/** Valor de un nivel de desempate para una entrada. */
function tieBreakValue(entry: RankableEntry, level: TieBreakLevel): number {
    if (level === "confidence") {
        return entry.confidence ?? 0;
    }
    if (level === "interview") {
        return entry.interviewScore ?? 0;
    }
    return entry.scores[level];
}

/**
 * Comparador de ranking (§15): score final COMBINADO descendente y, en
 * empate, los niveles de TIE_BREAK_ORDER en orden, también descendentes.
 * Devuelve 0 solo si el empate persiste tras la confianza (revisión manual).
 */
export function compareCandidates(a: RankableEntry, b: RankableEntry): number {
    const overallA = overallOf(a);
    const overallB = overallOf(b);
    if (overallA !== overallB) {
        return overallB - overallA;
    }
    for (const level of TIE_BREAK_ORDER) {
        const diff = tieBreakValue(b, level) - tieBreakValue(a, level);
        if (diff !== 0) {
            return diff;
        }
    }
    return 0;
}

/** Anotaciones que el ranking añade a cada entrada ordenada. */
export interface RankAnnotation {
    /** Posición 1..n en el ranking. */
    position: number;
    /** Score final combinado (§06) por el que se ordenó esta entrada. */
    overallScore: number;
    /** true si el combinado es solo el score de CV (sin entrevista puntuada). */
    provisional: boolean;
    /**
     * Nivel de desempate que resolvió un empate del combinado con una
     * entrada adyacente; null si no hubo empate (o si no se resolvió).
     */
    tieBreakApplied: TieBreakLevel | null;
    /** true si el empate persiste incluso tras la confianza (§15, paso 7). */
    needsManualReview: boolean;
}

/**
 * Ordena las entradas con {@link compareCandidates} (orden estable: a
 * empate total, se conserva el orden de entrada) y anota posición, score
 * combinado, si es provisional, desempate aplicado y revisión manual.
 */
export function rankEntries<T extends RankableEntry>(
    entries: T[],
): Array<T & RankAnnotation> {
    const sorted = [...entries].sort(compareCandidates);
    const ranked = sorted.map((entry, index) => {
        const { overall, provisional } = computeOverallScore(
            entry.cvScore,
            entry.interviewScore,
        );
        return {
            ...entry,
            position: index + 1,
            overallScore: overall,
            provisional,
            tieBreakApplied: null as TieBreakLevel | null,
            needsManualReview: false,
        };
    });

    for (let i = 1; i < ranked.length; i++) {
        const above = ranked[i - 1];
        const entry = ranked[i];
        if (above.overallScore !== entry.overallScore) {
            continue;
        }
        const resolver = TIE_BREAK_ORDER.find(
            (level) =>
                tieBreakValue(above, level) !== tieBreakValue(entry, level),
        );
        if (resolver) {
            // Se anota en ambas entradas empatadas, sin pisar un desempate
            // previo (cadenas de 3+ empatados conservan el primero aplicado).
            above.tieBreakApplied = above.tieBreakApplied ?? resolver;
            entry.tieBreakApplied = entry.tieBreakApplied ?? resolver;
        } else {
            above.needsManualReview = true;
            entry.needsManualReview = true;
        }
    }

    return ranked;
}
