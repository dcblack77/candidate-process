import { describe, expect, it } from "vitest";
import { estimateTokens, truncateToBudget } from "../src/ai/llm-client";

describe("estimateTokens (~3.6 chars/token)", () => {
    it("devuelve 0 para el texto vacío", () => {
        expect(estimateTokens("")).toBe(0);
    });

    it("estima 1 token para textos de hasta 3 caracteres", () => {
        expect(estimateTokens("abc")).toBe(1);
    });

    it("redondea hacia arriba (360 chars ≈ 100 tokens, 361 → 101)", () => {
        expect(estimateTokens("x".repeat(360))).toBe(100);
        expect(estimateTokens("x".repeat(361))).toBe(101);
    });
});

describe("truncateToBudget", () => {
    it("devuelve el texto intacto si cabe en el presupuesto", () => {
        const text = "hola mundo";
        expect(truncateToBudget(text, 100)).toBe(text);
    });

    it("trunca a ~3.6 chars por token cuando se excede", () => {
        const text = "x".repeat(1_000);
        const truncated = truncateToBudget(text, 100);
        expect(truncated.length).toBe(360);
        expect(text.startsWith(truncated)).toBe(true);
    });

    it("el texto truncado siempre cabe según estimateTokens", () => {
        const text = "y".repeat(5_000);
        const truncated = truncateToBudget(text, 123);
        expect(estimateTokens(truncated)).toBeLessThanOrEqual(123);
    });

    it("presupuesto 0 produce texto vacío", () => {
        expect(truncateToBudget("algo", 0)).toBe("");
    });
});
