import { describe, expect, it } from "vitest";
import { trimToSingleQuestion } from "../src/questions/trim-question";

/**
 * Una sola interrogación por pregunta (decisión del 2026-08-07). El prompt lo
 * pide y esto lo garantiza cuando el modelo no obedece.
 */
describe("trimToSingleQuestion", () => {
    it("corta la segunda pregunta de cola, que es la que alarga el bloque", () => {
        expect(
            trimToSingleQuestion(
                "¿Cómo estructuraste el pipeline con CodePipeline? ¿Qué consideraciones de seguridad implementaste?",
            ),
        ).toBe("¿Cómo estructuraste el pipeline con CodePipeline?");
    });

    it("de tres interrogaciones deja solo la primera", () => {
        expect(
            trimToSingleQuestion("¿Qué migraste? ¿Por qué? ¿Qué entregaste?"),
        ).toBe("¿Qué migraste?");
    });

    it("no toca una pregunta que ya es única", () => {
        const q = "¿Cuál fue la decisión de diseño más difícil de la migración?";
        expect(trimToSingleQuestion(q)).toBe(q);
    });

    it("respeta una indicación posterior si no es otra pregunta", () => {
        const q = "¿Qué hiciste en ese incidente? Ponme fechas concretas.";
        expect(trimToSingleQuestion(q)).toBe(q);
    });

    it("deja intactas las formulaciones sin interrogante", () => {
        const q = "Cuéntame una transición tecnológica concreta que hayas hecho.";
        expect(trimToSingleQuestion(q)).toBe(q);
    });

    it("no deja espacios sueltos al cortar", () => {
        expect(trimToSingleQuestion("¿Uno?   ¿Dos?")).toBe("¿Uno?");
    });
});
