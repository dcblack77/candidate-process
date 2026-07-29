import { randomUUID } from "node:crypto";
import { AppError } from "./errors";

/** Genera un identificador UUID v4. */
export function newId(): string {
    return randomUUID();
}

const UUID_V4_REGEX =
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Valida que un id recibido por la API sea un UUID v4 (BLUEPRINT §10:
 * "cada ID recibido se valida"). Lanza AppError INVALID_INPUT si no lo es.
 * El mensaje no repite el valor recibido para no reflejar entrada del cliente.
 */
export function assertValidId(id: unknown): asserts id is string {
    if (typeof id !== "string" || !UUID_V4_REGEX.test(id)) {
        throw new AppError("INVALID_INPUT", "El identificador no es válido.");
    }
}
