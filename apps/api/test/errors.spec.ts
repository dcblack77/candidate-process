import { NextFunction, Request, Response } from "express";
import { describe, expect, it, vi } from "vitest";
import { errorHandler } from "../src/shared/error-handler";
import { AppError, APP_ERROR_CODES } from "../src/shared/errors";

/** Doble mínimo de Response que captura status y body. */
function fakeResponse(): {
    res: Response;
    getStatus: () => number | undefined;
    getBody: () => unknown;
} {
    let status: number | undefined;
    let body: unknown;
    const res = {
        status(code: number) {
            status = code;
            return this;
        },
        json(payload: unknown) {
            body = payload;
            return this;
        },
    } as unknown as Response;
    return { res, getStatus: () => status, getBody: () => body };
}

const fakeRequest = {} as Request;
const fakeNext: NextFunction = () => undefined;

describe("AppError", () => {
    it("asigna httpStatus coherente a cada código", () => {
        const expected: Record<string, number> = {
            LIMIT_EXCEEDED: 422,
            NOT_FOUND: 404,
            RATE_LIMITED: 429,
            INVALID_INPUT: 400,
            LLM_UNAVAILABLE: 502,
            FORBIDDEN: 403,
            ACTIVE_PROCESS_EXISTS: 409,
        };
        for (const code of APP_ERROR_CODES) {
            const error = new AppError(code);
            expect(error.httpStatus, code).toBe(expected[code]);
            expect(error.code).toBe(code);
            expect(error.message.length).toBeGreaterThan(0);
        }
    });
});

describe("error-handler central", () => {
    it("responde {error:{code,message}} para AppError, sin stack ni extras", () => {
        const { res, getStatus, getBody } = fakeResponse();
        errorHandler(new AppError("NOT_FOUND"), fakeRequest, res, fakeNext);

        expect(getStatus()).toBe(404);
        const body = getBody() as Record<string, unknown>;
        // Estructura exacta: solo la clave "error" con code y message.
        expect(Object.keys(body)).toEqual(["error"]);
        expect(Object.keys(body.error as object).sort()).toEqual(["code", "message"]);
        expect(body.error).toMatchObject({ code: "NOT_FOUND" });
        expect(JSON.stringify(body)).not.toMatch(/stack/i);
    });

    it("un error desconocido responde 500 genérico sin filtrar su mensaje", () => {
        const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
        const { res, getStatus, getBody } = fakeResponse();
        const leaky = new Error("dato-secreto-del-cv");

        errorHandler(leaky, fakeRequest, res, fakeNext);

        expect(getStatus()).toBe(500);
        const serialized = JSON.stringify(getBody());
        expect(serialized).not.toContain("dato-secreto-del-cv");
        expect(serialized).not.toMatch(/stack/i);
        expect(getBody()).toMatchObject({ error: { code: "INTERNAL_ERROR" } });

        // Tampoco el log de consola debe contener el mensaje del error.
        const logged = consoleSpy.mock.calls.map((args) => args.join(" ")).join("\n");
        expect(logged).not.toContain("dato-secreto-del-cv");
        consoleSpy.mockRestore();
    });

    it("los valores no-Error también producen 500 genérico", () => {
        const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
        const { res, getStatus, getBody } = fakeResponse();

        errorHandler("cadena suelta", fakeRequest, res, fakeNext);

        expect(getStatus()).toBe(500);
        expect(getBody()).toMatchObject({ error: { code: "INTERNAL_ERROR" } });
        consoleSpy.mockRestore();
    });
});
