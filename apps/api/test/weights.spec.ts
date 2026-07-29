import { describe, expect, it } from "vitest";
import {
    compareCandidates,
    computeFinalScore,
    computeOverallScore,
    CriterionScores,
    CV_WEIGHT,
    INTERVIEW_WEIGHT,
    RankableEntry,
    rankEntries,
    TIE_BREAK_ORDER,
    WEIGHTS,
} from "../src/scoring/weights";

/**
 * Unit exhaustivo de scoring/weights.ts (BLUEPRINT §06 y §15): fórmula
 * exacta de la rúbrica calculada a mano, score final combinado 30/70,
 * redondeo, cada nivel de desempate por separado (incluida la nota de
 * entrevista), empate total → needsManualReview y orden estable.
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
    interviewScore: number | null = null,
): RankableEntry {
    return {
        cvScore: computeFinalScore(s),
        scores: s,
        interviewScore,
        confidence,
    };
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

    it("orden de desempate de §15, con la entrevista entre stack y confianza", () => {
        expect(TIE_BREAK_ORDER).toEqual([
            "adaptability",
            "fundamentals",
            "production",
            "depth",
            "stack",
            "interview",
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

describe("computeOverallScore (score final combinado §06)", () => {
    it("pesos exactos del combinado: 30% CV, 70% entrevista", () => {
        expect(CV_WEIGHT).toBe(0.3);
        expect(INTERVIEW_WEIGHT).toBe(0.7);
        expect(CV_WEIGHT + INTERVIEW_WEIGHT).toBe(1);
    });

    it.each([
        // cv*0.30 + (entrevista/2)*0.70, calculado a mano.
        [5, 10, 5], // 1.50 + 3.50
        [1, 2, 1], // 0.30 + 0.70
        [4, 6, 3.3], // 1.20 + 2.10
        [3, 8, 3.7], // 0.90 + 2.80
        [2, 10, 4.1], // 0.60 + 3.50
        [5, 1, 1.85], // 1.50 + 0.35
    ])(
        "cv %s y entrevista %s ⇒ combinado %s",
        (cvScore, interviewScore, expected) => {
            expect(computeOverallScore(cvScore, interviewScore)).toEqual({
                overall: expected,
                provisional: false,
            });
        },
    );

    it("sin entrevista puntuada: combinado = score de CV y provisional=true", () => {
        expect(computeOverallScore(4.55, null)).toEqual({
            overall: 4.55,
            provisional: true,
        });
        expect(computeOverallScore(1, null)).toEqual({
            overall: 1,
            provisional: true,
        });
    });

    it("redondea a 2 decimales sin residuos de coma flotante", () => {
        // 4.35*0.30 + 2.5*0.70 = 3.055 → 3.06 (y no 3.0549999…).
        expect(computeOverallScore(4.35, 5).overall).toBe(3.06);
        expect(computeOverallScore(3.33, 7.7).overall).toBe(3.69); // 0.999+2.695
    });

    it("caso real del usuario (2026-07-29): cuatro candidatos con entrevista", () => {
        // Números exactos verificados con los datos reales del proceso.
        const candidates = [
            { name: "Walter", cv: 4.55, interview: 7.7, overall: 4.06 },
            { name: "Hugo", cv: 4.35, interview: 5, overall: 3.06 },
            { name: "Stuart", cv: 4.3, interview: 5, overall: 3.04 },
            { name: "Alfonso", cv: 4.6, interview: 4.6, overall: 2.99 },
        ];

        for (const candidate of candidates) {
            expect(
                computeOverallScore(candidate.cv, candidate.interview).overall,
            ).toBe(candidate.overall);
        }

        // Y el orden resultante NO es el del CV (Alfonso tenía el mejor CV).
        const ranked = rankEntries(
            candidates.map((candidate) => ({
                name: candidate.name,
                cvScore: candidate.cv,
                scores: scores(3, 3, 3, 3, 3),
                interviewScore: candidate.interview,
                confidence: 0.5,
            })),
        );
        expect(ranked.map((r) => r.name)).toEqual([
            "Walter",
            "Hugo",
            "Stuart",
            "Alfonso",
        ]);
        expect(ranked.map((r) => r.overallScore)).toEqual([
            4.06, 3.06, 3.04, 2.99,
        ]);
        expect(ranked.map((r) => r.position)).toEqual([1, 2, 3, 4]);
        expect(ranked.every((r) => !r.provisional)).toBe(true);
    });
});

describe("compareCandidates y rankEntries: desempates de §15", () => {
    it("sin empate: ordena por score final descendente", () => {
        const low = entry(scores(2, 2, 2, 2, 2)); // 2.0
        const high = entry(scores(5, 5, 5, 5, 5)); // 5.0
        const mid = entry(scores(3, 3, 3, 3, 3)); // 3.0

        const ranked = rankEntries([low, high, mid]);
        expect(ranked.map((r) => r.cvScore)).toEqual([5, 3, 2]);
        expect(ranked.map((r) => r.overallScore)).toEqual([5, 3, 2]);
        expect(ranked.every((r) => r.provisional)).toBe(true);
        expect(ranked.map((r) => r.position)).toEqual([1, 2, 3]);
        expect(ranked.every((r) => r.tieBreakApplied === null)).toBe(true);
        expect(ranked.every((r) => !r.needsManualReview)).toBe(true);
    });

    it("nivel 1 — adaptabilidad: empate a 3.0 lo gana la mayor adaptabilidad", () => {
        const a = entry(scores(4, 3, 3, 1, 3)); // 1.2+0.75+0.6+0.15+0.3 = 3.0
        const b = entry(scores(3, 3, 3, 3, 3)); // 3.0
        expect(a.cvScore).toBe(b.cvScore);

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
        expect(a.cvScore).toBe(b.cvScore);

        expect(compareCandidates(a, b)).toBeLessThan(0);
        const ranked = rankEntries([b, a]);
        expect(ranked[0].scores.fundamentals).toBe(5);
        expect(ranked[0].tieBreakApplied).toBe("fundamentals");
    });

    it("nivel 3 — producción: va ANTES que profundidad (§15)", () => {
        const a = entry(scores(3, 3, 3, 5, 1)); // 0.9+0.75+0.6+0.75+0.1 = 3.1
        const b = entry(scores(3, 3, 3, 3, 4)); // 0.9+0.75+0.6+0.45+0.4 = 3.1
        expect(a.cvScore).toBe(b.cvScore);

        expect(compareCandidates(a, b)).toBeLessThan(0);
        const ranked = rankEntries([b, a]);
        expect(ranked[0].scores.production).toBe(5);
        expect(ranked[0].tieBreakApplied).toBe("production");
    });

    it("nivel 4 — profundidad: con adaptabilidad, fundamentos y producción iguales", () => {
        const a = entry(scores(3, 3, 4, 3, 1)); // 0.9+0.75+0.8+0.45+0.1 = 3.0
        const b = entry(scores(3, 3, 3, 3, 3)); // 3.0
        expect(a.cvScore).toBe(b.cvScore);

        expect(compareCandidates(a, b)).toBeLessThan(0);
        const ranked = rankEntries([b, a]);
        expect(ranked[0].scores.depth).toBe(4);
        expect(ranked[0].tieBreakApplied).toBe("depth");
    });

    it("nivel 5 — stack: decide cuando todo lo anterior está igualado", () => {
        // Con los 4 primeros criterios iguales, la suma ponderada solo puede
        // empatar si stack también empata; el nivel se cubre con cvScore
        // igualado explícitamente (compareCandidates opera sobre el campo).
        const a: RankableEntry = {
            cvScore: 3,
            scores: scores(3, 3, 3, 3, 4),
            interviewScore: null,
            confidence: 0.5,
        };
        const b: RankableEntry = {
            cvScore: 3,
            scores: scores(3, 3, 3, 3, 2),
            interviewScore: null,
            confidence: 0.5,
        };

        expect(compareCandidates(a, b)).toBeLessThan(0);
        expect(compareCandidates(b, a)).toBeGreaterThan(0);
        const ranked = rankEntries([b, a]);
        expect(ranked[0].scores.stack).toBe(4);
        expect(ranked[0].tieBreakApplied).toBe("stack");
        expect(ranked[1].tieBreakApplied).toBe("stack");
    });

    it("nivel 6 — entrevista: con el combinado empatado decide la nota de entrevista", () => {
        // Desde el combinado (0.30·cv + 0.35·nota) la entrevista ya ordena;
        // este nivel solo actúa cuando el combinado EMPATA con notas de
        // entrevista distintas: 0.30·3.3 + 0.35·6.6 = 0.30·4.0 + 0.35·6.0.
        const a: RankableEntry = {
            cvScore: 3.3,
            scores: scores(3, 3, 3, 3, 3),
            interviewScore: 6.6,
            confidence: 0.5,
        };
        const b: RankableEntry = {
            cvScore: 4,
            scores: scores(3, 3, 3, 3, 3),
            interviewScore: 6,
            confidence: 0.5,
        };

        expect(compareCandidates(a, b)).toBeLessThan(0);
        const ranked = rankEntries([b, a]);
        expect(ranked.map((r) => r.overallScore)).toEqual([3.3, 3.3]);
        expect(ranked[0].interviewScore).toBe(6.6);
        expect(ranked[0].tieBreakApplied).toBe("interview");
        expect(ranked[1].tieBreakApplied).toBe("interview");
        expect(ranked.every((r) => !r.needsManualReview)).toBe(true);
    });

    it("la entrevista se aplica ANTES que la confianza", () => {
        // Mismo combinado (3.3), menor confianza pero mejor entrevista: gana.
        const interviewed: RankableEntry = {
            cvScore: 3.3,
            scores: scores(3, 3, 3, 3, 3),
            interviewScore: 6.6,
            confidence: 0.1,
        };
        const onlyConfidence: RankableEntry = {
            cvScore: 4,
            scores: scores(3, 3, 3, 3, 3),
            interviewScore: 6,
            confidence: 0.9,
        };

        const ranked = rankEntries([onlyConfidence, interviewed]);
        expect(ranked[0].interviewScore).toBe(6.6);
        expect(ranked[0].confidence).toBe(0.1);
        expect(ranked[0].tieBreakApplied).toBe("interview");
    });

    it("entrevista null cuenta como 0 en el desempate: sin entrevista se queda detrás", () => {
        // CV perfecto y entrevista perfecta ⇒ combinado 5.0, igual que un CV
        // perfecto SIN entrevista (que no se penaliza, solo es provisional).
        const withInterview = entry(scores(5, 5, 5, 5, 5), 0.5, 10);
        const withoutInterview = entry(scores(5, 5, 5, 5, 5), 0.9, null);

        const ranked = rankEntries([withoutInterview, withInterview]);
        expect(ranked.map((r) => r.overallScore)).toEqual([5, 5]);
        expect(ranked[0].interviewScore).toBe(10);
        expect(ranked[0].provisional).toBe(false);
        expect(ranked[1].interviewScore).toBeNull();
        expect(ranked[1].provisional).toBe(true);
        expect(ranked[0].tieBreakApplied).toBe("interview");
    });

    it("nivel 7 — confianza: scores y entrevista idénticos, decide la mayor confianza", () => {
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

    it("empate total (incluidas entrevista y confianza) → needsManualReview en ambos", () => {
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
