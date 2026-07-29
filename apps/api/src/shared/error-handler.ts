import { NextFunction, Request, Response } from "express";
import { AppError, ErrorResponseBody } from "./errors";

/**
 * Manejador central de errores (BLUEPRINT §10):
 * - Responde siempre { error: { code, message } }.
 * - NUNCA incluye stack traces, payloads ni contenido sensible en la respuesta.
 * - En consola solo se registran el código o las líneas de stack (rutas de
 *   código), nunca el mensaje de errores desconocidos, que podría arrastrar
 *   contenido sensible (p. ej. SQL con datos de candidatos).
 */
export function errorHandler(
    err: unknown,
    _req: Request,
    res: Response,
    // Express identifica un error-handler por su aridad (4 parámetros).
    _next: NextFunction,
): void {
    if (err instanceof AppError) {
        const body: ErrorResponseBody = {
            error: { code: err.code, message: err.message },
        };
        res.status(err.httpStatus).json(body);
        return;
    }

    // Error no controlado: log mínimo sin mensaje (solo tipo y frames).
    if (err instanceof Error) {
        const frames = (err.stack ?? "")
            .split("\n")
            .slice(1)
            .join("\n");
        console.error(`[api] error no controlado (${err.name})\n${frames}`);
    } else {
        console.error("[api] error no controlado de tipo desconocido");
    }

    const body: ErrorResponseBody = {
        error: {
            code: "INTERNAL_ERROR",
            message: "Error interno. Revisa los logs locales del servidor.",
        },
    };
    res.status(500).json(body);
}
