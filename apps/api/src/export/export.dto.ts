import { AppError } from "../shared/errors";

/**
 * DTOs y validación de entrada del dominio Export (BLUEPRINT §19).
 */

/** Secciones seleccionables del export y sus DEFAULTS SEGUROS (§17/§19). */
export const DEFAULT_EXPORT_INCLUDE = {
    ranking: true,
    scoresByCriterion: true,
    summary: true,
    strengths: true,
    risks: true,
    questions: true,
    /** Notas privadas: NUNCA por defecto. */
    privateNotes: false,
    /**
     * Texto extraído del CV: NUNCA por defecto. Además, el sistema no lo
     * persiste (§04/§17), así que aunque se pida no puede incluirse; el
     * markdown lo documenta.
     */
    extractedText: false,
} as const;

export type ExportInclude = {
    -readonly [K in keyof typeof DEFAULT_EXPORT_INCLUDE]: boolean;
};

/** Respuesta de POST /export. La API no escribe en disco: la UI descarga. */
export interface ExportResponseDTO {
    format: "markdown";
    filename: string;
    content: string;
    exportsUsedThisSession: number;
    exportsLimit: number;
}

/**
 * Valida el body de POST /export: `{ include? }` con banderas booleanas.
 * Claves desconocidas o valores no booleanos → INVALID_INPUT. Lo no enviado
 * toma su default seguro.
 */
export function parseExportInput(body: unknown): ExportInclude {
    if (body === undefined || body === null) {
        return { ...DEFAULT_EXPORT_INCLUDE };
    }
    if (typeof body !== "object" || Array.isArray(body)) {
        throw new AppError(
            "INVALID_INPUT",
            "El cuerpo de la petición no es válido.",
        );
    }
    const { include, ...rest } = body as Record<string, unknown>;
    if (Object.keys(rest).length > 0) {
        throw new AppError(
            "INVALID_INPUT",
            "El cuerpo contiene campos no permitidos.",
        );
    }
    if (include === undefined) {
        return { ...DEFAULT_EXPORT_INCLUDE };
    }
    if (
        typeof include !== "object" ||
        include === null ||
        Array.isArray(include)
    ) {
        throw new AppError(
            "INVALID_INPUT",
            "include debe ser un objeto de banderas.",
        );
    }

    const result: ExportInclude = { ...DEFAULT_EXPORT_INCLUDE };
    for (const [key, value] of Object.entries(include)) {
        if (!(key in DEFAULT_EXPORT_INCLUDE)) {
            throw new AppError(
                "INVALID_INPUT",
                "include contiene claves no permitidas.",
            );
        }
        if (typeof value !== "boolean") {
            throw new AppError(
                "INVALID_INPUT",
                "Las banderas de include deben ser booleanas.",
            );
        }
        result[key as keyof ExportInclude] = value;
    }
    return result;
}
