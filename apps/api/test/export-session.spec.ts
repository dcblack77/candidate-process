import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExportSessionCounter } from "../src/export/export-session";
import { MAX_EXPORTS_PER_SESSION, RATE_LIMIT_WINDOW_MS } from "../src/shared/limits";

/**
 * El límite de exportaciones es una ventana deslizante de una hora
 * (2026-08-15), no un contador que solo sube: antes, a la undécima
 * exportación había que reiniciar la API.
 */
describe("ExportSessionCounter (ventana de una hora)", () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it("cuenta lo consumido dentro de la ventana", () => {
        const counter = new ExportSessionCounter();
        expect(counter.count).toBe(0);
        for (let i = 1; i <= MAX_EXPORTS_PER_SESSION; i++) {
            expect(counter.increment()).toBe(i);
        }
        expect(counter.count).toBe(MAX_EXPORTS_PER_SESSION);
    });

    it("pasada una hora las exportaciones antiguas dejan de contar", () => {
        const counter = new ExportSessionCounter();
        counter.increment();
        counter.increment();
        vi.advanceTimersByTime(RATE_LIMIT_WINDOW_MS / 2);
        counter.increment();
        expect(counter.count).toBe(3);

        // Las dos primeras salen de la ventana; la tercera sigue dentro.
        vi.advanceTimersByTime(RATE_LIMIT_WINDOW_MS / 2 + 1_000);
        expect(counter.count).toBe(1);
        expect(counter.increment()).toBe(2);
    });

    it("reset vacía la ventana", () => {
        const counter = new ExportSessionCounter();
        counter.increment();
        counter.reset();
        expect(counter.count).toBe(0);
    });
});
