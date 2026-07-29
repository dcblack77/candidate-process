import { Criterion } from "../ai/schemas/common";
import { CriterionVerdict } from "../ai/schemas/score-candidate";
import { InterviewScore } from "../scoring/interview-score";
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

/**
 * Formatos de salida de POST /export (§19: "Markdown primero, PDF después").
 *
 * - `markdown`: documento markdown listo para descargar (formato por defecto,
 *   así el contrato histórico no se rompe).
 * - `structured`: los MISMOS datos en JSON para que la UI los maquete en su
 *   vista de impresión y el navegador genere el PDF. La API sigue sin escribir
 *   en disco y sin depender de ninguna librería de PDF.
 */
export const EXPORT_FORMATS = ["markdown", "structured"] as const;

export type ExportFormat = (typeof EXPORT_FORMATS)[number];

/** Formato por defecto: el contrato previo a la vista de impresión. */
export const DEFAULT_EXPORT_FORMAT: ExportFormat = "markdown";

/** Entrada ya validada de POST /export. */
export interface ExportRequest {
    format: ExportFormat;
    include: ExportInclude;
}

/** Respuesta de POST /export en markdown. La UI descarga el contenido. */
export interface ExportMarkdownResponseDTO {
    format: "markdown";
    filename: string;
    content: string;
    exportsUsedThisSession: number;
    exportsLimit: number;
}

/** Pregunta recomendada tal y como sale al documento (§19). */
export interface ExportQuestionDTO {
    question: string;
    /** Nota 1-10 de la respuesta; null si no está puntuada. */
    answerScore: number | null;
    /**
     * Texto de la respuesta: dato privado (§17). Solo viaja con
     * `include.privateNotes=true`; en caso contrario siempre null.
     */
    answerNotes: string | null;
}

/** Ficha de un candidato en el export estructurado (§19). */
export interface ExportCandidateDTO {
    position: number;
    name: string;
    /** Score de la rúbrica §06 (1-5): lo que promete el CV. */
    cvScore: number;
    /** Score final combinado CV/entrevista (§06): el que ordena. */
    overallScore: number;
    /** true si aún no tiene entrevista puntuada (combinado = score de CV). */
    provisional: boolean;
    /** Notas 1-5 por criterio; null si se excluyó `scoresByCriterion`. */
    scores: Record<Criterion, number> | null;
    /**
     * Veredicto del contraste por criterio (null en análisis antiguos); el
     * registro entero es null si se excluyó `scoresByCriterion`.
     */
    verdicts: Record<Criterion, CriterionVerdict | null> | null;
    confidence: number | null;
    needsManualReview: boolean;
    /** Resumen profesional breve; null si se excluyó o no existe. */
    summary: string | null;
    strengths: string[];
    risks: string[];
    /** Dudas pendientes de validar en entrevista (§13). */
    doubts: string[];
    questions: ExportQuestionDTO[];
    /** Agregados numéricos de entrevista (no sensibles, §19). */
    interview: InterviewScore;
    /** Notas del evaluador: solo con `include.privateNotes=true`; si no, null. */
    manualNotes: string | null;
}

/**
 * Respuesta de POST /export en formato estructurado: los mismos datos que
 * alimentan el markdown, en JSON, para la vista de impresión de la UI.
 *
 * La UI NUNCA renderiza markdown como HTML: este payload existe justamente
 * para que el contenido del modelo y del CV se pinte con React (escapado
 * automático) y no pueda inyectar enlaces ni imágenes de exfiltración.
 */
export interface ExportStructuredResponseDTO {
    format: "structured";
    /** Nombre sugerido del PDF (`export-<slug>-<fecha>.pdf`). */
    filename: string;
    /** Marca de tiempo ISO completa de la generación. */
    generatedAt: string;
    roleTitle: string;
    roleContext: string | null;
    /** Pesos de la rúbrica (única fuente: scoring/weights.ts). */
    weights: Record<Criterion, number>;
    /** Pesos del combinado CV/entrevista (misma única fuente). */
    scoreWeights: { cv: number; interview: number };
    entries: ExportCandidateDTO[];
    /** Nombres de los candidatos sin puntuación completa. */
    unscored: string[];
    /** Banderas efectivamente aplicadas (la vista las necesita para avisar). */
    include: ExportInclude;
    exportsUsedThisSession: number;
    exportsLimit: number;
}

export type ExportResponseDTO =
    | ExportMarkdownResponseDTO
    | ExportStructuredResponseDTO;

/**
 * Valida el body de POST /export: `{ format?, include? }`. Claves
 * desconocidas, formato no soportado o banderas no booleanas → INVALID_INPUT.
 * Lo no enviado toma su default seguro.
 */
export function parseExportInput(body: unknown): ExportRequest {
    if (body === undefined || body === null) {
        return defaultRequest();
    }
    if (typeof body !== "object" || Array.isArray(body)) {
        throw new AppError(
            "INVALID_INPUT",
            "El cuerpo de la petición no es válido.",
        );
    }
    const { include, format, ...rest } = body as Record<string, unknown>;
    if (Object.keys(rest).length > 0) {
        throw new AppError(
            "INVALID_INPUT",
            "El cuerpo contiene campos no permitidos.",
        );
    }
    return {
        format: parseExportFormat(format),
        include: parseExportInclude(include),
    };
}

function defaultRequest(): ExportRequest {
    return {
        format: DEFAULT_EXPORT_FORMAT,
        include: { ...DEFAULT_EXPORT_INCLUDE },
    };
}

/** `format` ausente → markdown; cualquier otro valor debe ser conocido. */
function parseExportFormat(format: unknown): ExportFormat {
    if (format === undefined) {
        return DEFAULT_EXPORT_FORMAT;
    }
    if (
        typeof format !== "string" ||
        !(EXPORT_FORMATS as readonly string[]).includes(format)
    ) {
        throw new AppError(
            "INVALID_INPUT",
            "format debe ser 'markdown' o 'structured'.",
        );
    }
    return format as ExportFormat;
}

function parseExportInclude(include: unknown): ExportInclude {
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
