import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RateLimiter } from "../src/security/rate-limit";
import { AppError } from "../src/shared/errors";
import { RATE_LIMIT_WINDOW_MS } from "../src/shared/limits";

describe("RateLimiter (ventana deslizante en memoria)", () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it("permite hasta el límite y lanza RATE_LIMITED en el siguiente intento", () => {
        const limiter = new RateLimiter();
        for (let i = 0; i < 3; i++) {
            expect(() => limiter.check("analyze", 3)).not.toThrow();
        }
        try {
            limiter.check("analyze", 3);
            expect.unreachable("debería haber lanzado");
        } catch (error) {
            expect(error).toBeInstanceOf(AppError);
            const appError = error as AppError;
            expect(appError.code).toBe("RATE_LIMITED");
            expect(appError.httpStatus).toBe(429);
        }
    });

    it("las claves son independientes entre sí", () => {
        const limiter = new RateLimiter();
        limiter.check("extract", 1);
        expect(() => limiter.check("questions", 1)).not.toThrow();
        expect(() => limiter.check("extract", 1)).toThrow(AppError);
    });

    it("la ventana desliza: al expirar usos antiguos vuelve a permitir", () => {
        const limiter = new RateLimiter();
        limiter.check("ranking", 2);
        // 30 minutos después, segundo uso.
        vi.advanceTimersByTime(RATE_LIMIT_WINDOW_MS / 2);
        limiter.check("ranking", 2);
        // Límite alcanzado dentro de la ventana.
        expect(() => limiter.check("ranking", 2)).toThrow(AppError);

        // 31 minutos más tarde el primer uso ya salió de la ventana:
        // debe permitir exactamente uno más.
        vi.advanceTimersByTime(RATE_LIMIT_WINDOW_MS / 2 + 60_000);
        expect(() => limiter.check("ranking", 2)).not.toThrow();
        expect(() => limiter.check("ranking", 2)).toThrow(AppError);
    });

    it("un intento rechazado no consume cupo de la ventana", () => {
        const limiter = new RateLimiter();
        limiter.check("extract", 1);
        expect(() => limiter.check("extract", 1)).toThrow(AppError);

        // Pasada la ventana completa desde el único uso válido, vuelve a entrar.
        vi.advanceTimersByTime(RATE_LIMIT_WINDOW_MS + 1_000);
        expect(() => limiter.check("extract", 1)).not.toThrow();
    });
});

describe("RateLimiter.refund", () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it("devuelve el último uso y deja sitio para uno más", () => {
        const limiter = new RateLimiter();
        limiter.check("interview", 1);
        expect(() => limiter.check("interview", 1)).toThrow(AppError);
        limiter.refund("interview");
        expect(() => limiter.check("interview", 1)).not.toThrow();
    });

    it("sin usos registrados no hace nada ni rompe", () => {
        const limiter = new RateLimiter();
        expect(() => limiter.refund("nada")).not.toThrow();
        limiter.check("nada", 1);
        expect(() => limiter.check("nada", 1)).toThrow(AppError);
    });

    it("solo devuelve UN uso por llamada", () => {
        const limiter = new RateLimiter();
        limiter.check("interview", 2);
        limiter.check("interview", 2);
        limiter.refund("interview");
        expect(() => limiter.check("interview", 2)).not.toThrow();
        expect(() => limiter.check("interview", 2)).toThrow(AppError);
    });
});
