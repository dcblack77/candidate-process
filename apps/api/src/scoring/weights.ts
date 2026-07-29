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
 * Orden de desempate (§15): adaptabilidad → fundamentos → producción →
 * profundidad → stack → confianza. Si tras confianza persiste el empate,
 * el ranking marca `needsManualReview` (revisión manual).
 */
export const TIE_BREAK_ORDER = [
    "adaptability",
    "fundamentals",
    "production",
    "depth",
    "stack",
    "confidence",
] as const;

export type TieBreakLevel = (typeof TIE_BREAK_ORDER)[number];

/** Puntuaciones 1-5 por criterio. */
export type CriterionScores = Record<Criterion, number>;

/**
 * Fórmula de §06: suma ponderada de los cinco criterios, redondeada a
 * 2 decimales. El backend SIEMPRE recalcula con esta función; cualquier
 * `final_score` que proponga el modelo se descarta.
 */
export function computeFinalScore(scores: CriterionScores): number {
    const sum = CRITERIA.reduce(
        (total, criterion) => total + scores[criterion] * WEIGHTS[criterion],
        0,
    );
    return Math.round(sum * 100) / 100;
}

/** Entrada mínima que necesita el comparador de ranking. */
export interface RankableEntry {
    finalScore: number;
    scores: CriterionScores;
    /** Confianza 0-1 del análisis; null cuenta como 0 en el desempate. */
    confidence: number | null;
}

/** Valor de un nivel de desempate para una entrada. */
function tieBreakValue(entry: RankableEntry, level: TieBreakLevel): number {
    return level === "confidence"
        ? (entry.confidence ?? 0)
        : entry.scores[level];
}

/**
 * Comparador de ranking (§15): score final descendente y, en empate, los
 * niveles de TIE_BREAK_ORDER en orden, también descendentes. Devuelve 0
 * solo si el empate persiste tras la confianza (revisión manual).
 */
export function compareCandidates(a: RankableEntry, b: RankableEntry): number {
    if (a.finalScore !== b.finalScore) {
        return b.finalScore - a.finalScore;
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
    /**
     * Nivel de desempate que resolvió un empate de score final con una
     * entrada adyacente; null si no hubo empate (o si no se resolvió).
     */
    tieBreakApplied: TieBreakLevel | null;
    /** true si el empate persiste incluso tras la confianza (§15, paso 7). */
    needsManualReview: boolean;
}

/**
 * Ordena las entradas con {@link compareCandidates} (orden estable: a
 * empate total, se conserva el orden de entrada) y anota posición,
 * desempate aplicado y necesidad de revisión manual.
 */
export function rankEntries<T extends RankableEntry>(
    entries: T[],
): Array<T & RankAnnotation> {
    const sorted = [...entries].sort(compareCandidates);
    const ranked = sorted.map((entry, index) => ({
        ...entry,
        position: index + 1,
        tieBreakApplied: null as TieBreakLevel | null,
        needsManualReview: false,
    }));

    for (let i = 1; i < ranked.length; i++) {
        const above = ranked[i - 1];
        const entry = ranked[i];
        if (above.finalScore !== entry.finalScore) {
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
