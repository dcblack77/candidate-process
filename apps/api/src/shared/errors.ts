/**
 * Errores de aplicación (BLUEPRINT §10 y §17).
 *
 * Regla: los errores que viajan al cliente NUNCA contienen datos sensibles
 * (texto de CV, resúmenes, notas, prompts, stack traces ni payloads).
 * Solo un código estable y un mensaje genérico.
 */

export const APP_ERROR_CODES = [
    "LIMIT_EXCEEDED",
    "NOT_FOUND",
    "RATE_LIMITED",
    "INVALID_INPUT",
    "LLM_UNAVAILABLE",
    "FORBIDDEN",
    "ACTIVE_PROCESS_EXISTS",
    // Subida de CV (§16): tamaño y formato tienen códigos HTTP propios
    // (413/415) distintos del 422 de LIMIT_EXCEEDED y del 400 de INVALID_INPUT.
    "FILE_TOO_LARGE",
    "UNSUPPORTED_MEDIA_TYPE",
] as const;

export type AppErrorCode = (typeof APP_ERROR_CODES)[number];

/** Estado HTTP asociado a cada código de error. */
const HTTP_STATUS_BY_CODE: Record<AppErrorCode, number> = {
    LIMIT_EXCEEDED: 422,
    NOT_FOUND: 404,
    RATE_LIMITED: 429,
    INVALID_INPUT: 400,
    LLM_UNAVAILABLE: 502,
    FORBIDDEN: 403,
    ACTIVE_PROCESS_EXISTS: 409,
    FILE_TOO_LARGE: 413,
    UNSUPPORTED_MEDIA_TYPE: 415,
};

/**
 * Mensaje genérico por defecto para cada código. Sin datos del dominio:
 * quien necesite contexto debe mirar la auditoría (app_event), no el error.
 */
const DEFAULT_MESSAGE_BY_CODE: Record<AppErrorCode, string> = {
    LIMIT_EXCEEDED: "Se alcanzó el límite permitido para esta acción.",
    NOT_FOUND: "El recurso solicitado no existe.",
    RATE_LIMITED: "Demasiadas peticiones. Inténtalo de nuevo más tarde.",
    INVALID_INPUT: "La petición contiene datos inválidos.",
    LLM_UNAVAILABLE: "El modelo local no está disponible en este momento.",
    FORBIDDEN: "No tienes permiso para realizar esta acción.",
    ACTIVE_PROCESS_EXISTS: "Ya existe un proceso activo.",
    FILE_TOO_LARGE: "El archivo supera el tamaño máximo permitido.",
    UNSUPPORTED_MEDIA_TYPE: "El formato de archivo no está permitido (PDF, DOCX o TXT).",
};

/**
 * Error de aplicación tipado. El mensaje debe ser siempre genérico:
 * no incluir nombres, resúmenes, notas ni contenido de CVs.
 */
export class AppError extends Error {
    readonly code: AppErrorCode;
    readonly httpStatus: number;

    constructor(code: AppErrorCode, message?: string) {
        super(message ?? DEFAULT_MESSAGE_BY_CODE[code]);
        this.name = "AppError";
        this.code = code;
        this.httpStatus = HTTP_STATUS_BY_CODE[code];
    }
}

/** Cuerpo estándar de respuesta de error: { error: { code, message } }. */
export interface ErrorResponseBody {
    error: {
        code: string;
        message: string;
    };
}
