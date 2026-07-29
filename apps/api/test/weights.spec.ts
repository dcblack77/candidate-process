import { describe, expect, it } from "vitest";
import {
    compareCandidates,
    computeFinalScore,
    CriterionScores,
    RankableEntry,
    rankEntries,
    TIE_BREAK_ORDER,
    WEIGHTS,
} from "../src/scoring/weights";

/**
 * Unit exhaustivo de scoring/weights.ts (BLUEPRINT §06 y §15): fórmula
 * exacta calculada a mano, redondeo, cada nivel de desempate por separado,
 * empate total → needsManualReview y orden estable.
 */

function scores(
    adaptability: number,
    fundamentals: number,
    depth: number,
    production: number,
    stack: number,
): CriterionScores {
    return { adaptability, fundamentals, depth, production, stack };
}

function entry(
    s: CriterionScores,
    confidence: number | null = 0.5,
): RankableEntry {
    return { finalScore: computeFinalScore(s), scores: s, confidence };
}

describe("WEIGHTS y TIE_BREAK_ORDER (única fuente)", () => {
    it("pesos exactos de §06 y suman 1", () => {
        expect(WEIGHTS).toEqual({
            adaptability: 0.3,
            fundamentals: 0.25,
            depth: 0.2,
            production: 0.15,
            stack: 0.1,
        });
        const sum = Object.values(WEIGHTS).reduce((a, b) => a + b, 0);
        expect(Math.round(sum * 100) / 100).toBe(1);
    });

    it("orden de desempate de §15", () => {
        expect(TIE_BREAK_ORDER).toEqual([
            "adaptability",
            "fundamentals",
            "production",
            "depth",
            "stack",
            "confidence",
        ]);
    });
});

describe("computeFinalScore (fórmula §06)", () => {
    it.each([
        // Casos calculados a mano: a*0.30 + f*0.25 + d*0.20 + p*0.15 + s*0.10
        [scores(5, 5, 5, 5, 5), 5],
        [scores(1, 1, 1, 1, 1), 1],
        [scores(3, 4, 2, 5, 1), 3.15], // 0.90+1.00+0.40+0.75+0.10
        [scores(4, 3, 5, 2, 3), 3.55], // 1.20+0.75+1.00+0.30+0.30
        [scores(2, 5, 1, 4, 3), 2.95], // 0.60+1.25+0.20+0.60+0.30
        [scores(5, 4, 3, 2, 1), 3.5], // 1.50+1.00+0.60+0.30+0.10
        [scores(1, 2, 3, 4, 5), 2.5], // 0.30+0.50+0.60+0.60+0.50
    ])("caso %#: suma ponderada exacta", (input, expected) => {
        expect(computeFinalScore(input)).toBe(expected);
    });

    it("sin residuos de coma flotante (resultado exacto a 2 decimales)", () => {
        // 0.3+0.25+0.4+0.15+0.2 = 1.3000000000000003 sin redondeo.
        expect(computeFinalScore(scores(1, 1, 2, 1, 2))).toBe(1.3);
    });

    it("redondea a 2 decimales cuando la suma tiene más precisión", () => {
        // 3.333*0.3 = 0.9999 → total 0.9999+... redondeado a 2 decimales.
        expect(computeFinalScore(scores(3.333, 1, 1, 1, 1))).toBe(1.7); // 0.9999+0.25+0.2+0.15+0.1=1.6999
        expect(computeFinalScore(scores(1.004, 1, 1, 1, 1))).toBe(1);
    });
});

describe("compareCandidates y rankEntries: desempates de §15", () => {
    it("sin empate: ordena por score final descendente", () => {
        const low = entry(scores(2, 2, 2, 2, 2)); // 2.0
        const high = entry(scores(5, 5, 5, 5, 5)); // 5.0
        const mid = entry(scores(3, 3, 3, 3, 3)); // 3.0

        const ranked = rankEntries([low, high, mid]);
        expect(ranked.map((r) => r.finalScore)).toEqual([5, 3, 2]);
        expect(ranked.map((r) => r.position)).toEqual([1, 2, 3]);
        expect(ranked.every((r) => r.tieBreakApplied === null)).toBe(true);
        expect(ranked.every((r) => !r.needsManualReview)).toBe(true);
    });

    it("nivel 1 — adaptabilidad: empate a 3.0 lo gana la mayor adaptabilidad", () => {
        const a = entry(scores(4, 3, 3, 1, 3)); // 1.2+0.75+0.6+0.15+0.3 = 3.0
        const b = entry(scores(3, 3, 3, 3, 3)); // 3.0
        expect(a.finalScore).toBe(b.finalScore);

        expect(compareCandidates(a, b)).toBeLessThan(0);
        const ranked = rankEntries([b, a]);
        expect(ranked[0].scores.adaptability).toBe(4);
        expect(ranked[0].tieBreakApplied).toBe("adaptability");
        expect(ranked[1].tieBreakApplied).toBe("adaptability");
        expect(ranked.every((r) => !r.needsManualReview)).toBe(true);
    });

    it("nivel 2 — fundamentos: con adaptabilidad igual decide fundamentos", () => {
        const a = entry(scores(3, 5, 3, 1, 1)); // 0.9+1.25+0.6+0.15+0.1 = 3.0
        const b = entry(scores(3, 3, 3, 3, 3)); // 3.0
        expect(a.finalScore).toBe(b.finalScore);

        expect(compareCandidates(a, b)).toBeLessThan(0);
        const ranked = rankEntries([b, a]);
        expect(ranked[0].scores.fundamentals).toBe(5);
        expect(ranked[0].tieBreakApplied).toBe("fundamentals");
    });

    it("nivel 3 — producción: va ANTES que profundidad (§15)", () => {
        const a = entry(scores(3, 3, 3, 5, 1)); // 0.9+0.75+0.6+0.75+0.1 = 3.1
        const b = entry(scores(3, 3, 3, 3, 4)); // 0.9+0.75+0.6+0.45+0.4 = 3.1
        expect(a.finalScore).toBe(b.finalScore);

        expect(compareCandidates(a, b)).toBeLessThan(0);
        const ranked = rankEntries([b, a]);
        expect(ranked[0].scores.production).toBe(5);
        expect(ranked[0].tieBreakApplied).toBe("production");
    });

    it("nivel 4 — profundidad: con adaptabilidad, fundamentos y producción iguales", () => {
        const a = entry(scores(3, 3, 4, 3, 1)); // 0.9+0.75+0.8+0.45+0.1 = 3.0
        const b = entry(scores(3, 3, 3, 3, 3)); // 3.0
        expect(a.finalScore).toBe(b.finalScore);

        expect(compareCandidates(a, b)).toBeLessThan(0);
        const ranked = rankEntries([b, a]);
        expect(ranked[0].scores.depth).toBe(4);
        expect(ranked[0].tieBreakApplied).toBe("depth");
    });

    it("nivel 5 — stack: decide cuando todo lo anterior está igualado", () => {
        // Con los 4 primeros criterios iguales, la suma ponderada solo puede
        // empatar si stack también empata; el nivel se cubre con finalScore
        // igualado explícitamente (compareCandidates opera sobre el campo).
        const a: RankableEntry = {
            finalScore: 3,
            scores: scores(3, 3, 3, 3, 4),
            confidence: 0.5,
        };
        const b: RankableEntry = {
            finalScore: 3,
            scores: scores(3, 3, 3, 3, 2),
            confidence: 0.5,
        };

        expect(compareCandidates(a, b)).toBeLessThan(0);
        expect(compareCandidates(b, a)).toBeGreaterThan(0);
        const ranked = rankEntries([b, a]);
        expect(ranked[0].scores.stack).toBe(4);
        expect(ranked[0].tieBreakApplied).toBe("stack");
        expect(ranked[1].tieBreakApplied).toBe("stack");
    });

    it("nivel 6 — confianza: scores idénticos, decide la mayor confianza", () => {
        const a = entry(scores(3, 3, 3, 3, 3), 0.9);
        const b = entry(scores(3, 3, 3, 3, 3), 0.4);

        expect(compareCandidates(a, b)).toBeLessThan(0);
        const ranked = rankEntries([b, a]);
        expect(ranked[0].confidence).toBe(0.9);
        expect(ranked[0].tieBreakApplied).toBe("confidence");
        expect(ranked.every((r) => !r.needsManualReview)).toBe(true);
    });

    it("confianza null cuenta como 0 en el desempate", () => {
        const withConfidence = entry(scores(3, 3, 3, 3, 3), 0.1);
        const withoutConfidence = entry(scores(3, 3, 3, 3, 3), null);

        const ranked = rankEntries([withoutConfidence, withConfidence]);
        expect(ranked[0].confidence).toBe(0.1);
        expect(ranked[0].tieBreakApplied).toBe("confidence");
    });

    it("empate total (incluida confianza) → needsManualReview en ambos", () => {
        const a = entry(scores(3, 3, 3, 3, 3), 0.5);
        const b = entry(scores(3, 3, 3, 3, 3), 0.5);

        expect(compareCandidates(a, b)).toBe(0);
        const ranked = rankEntries([a, b]);
        expect(ranked[0].needsManualReview).toBe(true);
        expect(ranked[1].needsManualReview).toBe(true);
        expect(ranked[0].tieBreakApplied).toBeNull();
        expect(ranked[1].tieBreakApplied).toBeNull();
        // El resto de entradas no se contamina.
        const third = entry(scores(5, 5, 5, 5, 5), 0.5);
        const withThird = rankEntries([a, third, b]);
        expect(withThird[0].needsManualReview).toBe(false);
    });

    it("orden estable: a empate total se conserva el orden de entrada", () => {
        type Tagged = RankableEntry & { tag: string };
        const tagged = (tag: string): Tagged => ({
            ...entry(scores(3, 3, 3, 3, 3), 0.5),
            tag,
        });

        const ranked = rankEntries([
            tagged("primero"),
            tagged("segundo"),
            tagged("tercero"),
        ]);
        expect(ranked.map((r) => r.tag)).toEqual([
            "primero",
            "segundo",
            "tercero",
        ]);
        expect(ranked.map((r) => r.position)).toEqual([1, 2, 3]);
        expect(ranked.every((r) => r.needsManualReview)).toBe(true);
    });

    it("rankEntries no muta el array de entrada", () => {
        const input = [
            entry(scores(1, 1, 1, 1, 1)),
            entry(scores(5, 5, 5, 5, 5)),
        ];
        const copy = [...input];
        rankEntries(input);
        expect(input).toEqual(copy);
    });
});
