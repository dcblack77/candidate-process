import { describe, expect, it } from "vitest";
import {
    AnsweredQuestion,
    computeInterviewScore,
    emptyInterviewScore,
    MAX_ANSWER_SCORE,
    MIN_ANSWER_SCORE,
} from "../src/scoring/interview-score";
import { WEIGHTS } from "../src/scoring/weights";

/**
 * Unit exhaustivo de scoring/interview-score.ts: medias por criterio,
 * global ponderado con RENORMALIZACIÓN sobre los criterios presentes,
 * redondeo a 1 decimal y ausencia total de respuestas.
 */

function question(
    criterion: string,
    answerScore: number | null,
): AnsweredQuestion {
    return { criterion, answerScore };
}

describe("constantes de la nota de respuesta", () => {
    it("el rango es 1-10 (10 = respuesta que más se ajusta a lo esperado)", () => {
        expect(MIN_ANSWER_SCORE).toBe(1);
        expect(MAX_ANSWER_SCORE).toBe(10);
    });
});

describe("computeInterviewScore — sin respuestas puntuadas", () => {
    it("lista vacía: overall null y todos los criterios null", () => {
        const result = computeInterviewScore([]);
        expect(result.overall).toBeNull();
        expect(result.answeredCount).toBe(0);
        expect(result.totalCount).toBe(0);
        expect(result.byCriterion).toEqual({
            adaptability: null,
            fundamentals: null,
            depth: null,
            production: null,
            stack: null,
        });
    });

    it("preguntas sin nota: totalCount cuenta, overall sigue null", () => {
        const result = computeInterviewScore([
            question("adaptability", null),
            question("stack", null),
        ]);
        expect(result.overall).toBeNull();
        expect(result.answeredCount).toBe(0);
        expect(result.totalCount).toBe(2);
        expect(result.byCriterion.adaptability).toBeNull();
    });

    it("emptyInterviewScore equivale a la lista vacía", () => {
        expect(emptyInterviewScore()).toEqual(computeInterviewScore([]));
    });
});

describe("computeInterviewScore — media por criterio", () => {
    it("promedia solo las preguntas puntuadas de cada criterio", () => {
        const result = computeInterviewScore([
            question("adaptability", 8),
            question("adaptability", 6),
            question("adaptability", null), // no cuenta
            question("stack", 10),
        ]);

        expect(result.byCriterion.adaptability).toEqual({
            average: 7,
            answered: 2,
        });
        expect(result.byCriterion.stack).toEqual({ average: 10, answered: 1 });
        expect(result.byCriterion.depth).toBeNull();
        expect(result.answeredCount).toBe(3);
        expect(result.totalCount).toBe(4);
    });

    it("redondea la media del criterio a 1 decimal", () => {
        // (8+7+7)/3 = 7.333… → 7.3
        const result = computeInterviewScore([
            question("depth", 8),
            question("depth", 7),
            question("depth", 7),
        ]);
        expect(result.byCriterion.depth?.average).toBe(7.3);
        // Con un único criterio, el global es su media (peso renormalizado a 1).
        expect(result.overall).toBe(7.3);
    });

    it("ignora criterios desconocidos (defensivo)", () => {
        const result = computeInterviewScore([
            question("carisma", 10),
            question("stack", 5),
        ]);
        expect(result.answeredCount).toBe(1);
        expect(result.overall).toBe(5);
    });
});

describe("computeInterviewScore — global ponderado y renormalización", () => {
    it("todos los criterios presentes: media ponderada con los pesos de §06", () => {
        const result = computeInterviewScore([
            question("adaptability", 10),
            question("fundamentals", 8),
            question("depth", 6),
            question("production", 4),
            question("stack", 2),
        ]);
        // 10*0.30 + 8*0.25 + 6*0.20 + 4*0.15 + 2*0.10 = 3+2+1.2+0.6+0.2 = 7.0
        expect(result.overall).toBe(7);
        expect(result.answeredCount).toBe(5);
    });

    it("solo adaptabilidad y stack: renormaliza sobre 0.40 (caso del enunciado)", () => {
        const result = computeInterviewScore([
            question("adaptability", 9),
            question("stack", 5),
        ]);
        // (9*0.30 + 5*0.10) / 0.40 = (2.7 + 0.5) / 0.40 = 8.0
        expect(result.overall).toBe(8);
        expect(WEIGHTS.adaptability + WEIGHTS.stack).toBeCloseTo(0.4, 10);
    });

    it("un solo criterio puntuado: el global es exactamente su media", () => {
        const result = computeInterviewScore([
            question("production", 3),
            question("production", 6),
        ]);
        expect(result.byCriterion.production).toEqual({
            average: 4.5,
            answered: 2,
        });
        expect(result.overall).toBe(4.5);
    });

    it("el criterio con más peso arrastra más el global", () => {
        const adaptabilityHigh = computeInterviewScore([
            question("adaptability", 10),
            question("stack", 2),
        ]);
        const stackHigh = computeInterviewScore([
            question("adaptability", 2),
            question("stack", 10),
        ]);
        // (10*0.3+2*0.1)/0.4 = 8; (2*0.3+10*0.1)/0.4 = 4
        expect(adaptabilityHigh.overall).toBe(8);
        expect(stackHigh.overall).toBe(4);
    });

    it("el global se calcula sobre medias SIN redondear y se redondea al final", () => {
        // adaptabilidad: (8+7+7)/3 = 7.333…  fundamentos: 5
        // (7.333…*0.30 + 5*0.25) / 0.55 = (2.2 + 1.25)/0.55 = 6.2727… → 6.3
        const result = computeInterviewScore([
            question("adaptability", 8),
            question("adaptability", 7),
            question("adaptability", 7),
            question("fundamentals", 5),
        ]);
        expect(result.byCriterion.adaptability?.average).toBe(7.3);
        expect(result.overall).toBe(6.3);
    });

    it("todas las respuestas al máximo o al mínimo dan el extremo exacto", () => {
        const best = computeInterviewScore(
            [
                "adaptability",
                "fundamentals",
                "depth",
                "production",
                "stack",
            ].map((criterion) => question(criterion, MAX_ANSWER_SCORE)),
        );
        const worst = computeInterviewScore(
            ["adaptability", "stack"].map((criterion) =>
                question(criterion, MIN_ANSWER_SCORE),
            ),
        );
        expect(best.overall).toBe(10);
        expect(worst.overall).toBe(1);
    });

    it("es puro: no muta la entrada", () => {
        const input = [question("adaptability", 5), question("stack", 7)];
        const copy = structuredClone(input);
        computeInterviewScore(input);
        expect(input).toEqual(copy);
    });
});
