import { AppError } from "../shared/errors";
import {
    MAX_QUOTES_PER_PROPOSAL,
    MAX_QUOTE_CHARS,
} from "../shared/limits";
import { ProposalRow } from "./proposal.repository";
import { RecordingRow } from "./recording.repository";
import { StoredTrack } from "./recording-store";

/**
 * DTOs y validación de entrada del dominio Interview (BLUEPRINT §24).
 *
 * Los usecases reciben el body crudo (`unknown`) y lo validan aquí. Los
 * mensajes de error nunca reflejan el valor recibido: en este dominio ese
 * valor puede ser transcripción de una persona real.
 */

/**
 * Hasta qué punto el candidato abordó el tema de una pregunta. El orden de
 * la lista es de menos a más y el código depende de él (`coverageRank`).
 *
 * `mencionado` NO es cobertura: nombrar la tecnología de pasada no demuestra
 * nada, y confundirlo con cobertura es el falso positivo que haría inútil
 * toda la funcionalidad.
 */
export const COVERAGE_LEVELS = [
    "no_abordado",
    "mencionado",
    "abordado_parcial",
    "abordado_demostrado",
] as const;

export type CoverageLevel = (typeof COVERAGE_LEVELS)[number];

/** Posición de un nivel de cobertura (0 = no abordado). */
export function coverageRank(level: CoverageLevel): number {
    return COVERAGE_LEVELS.indexOf(level);
}

/** Niveles que admiten nota propuesta. Fuera de estos, la nota se anula. */
export function isCovered(level: CoverageLevel): boolean {
    return level === "abordado_parcial" || level === "abordado_demostrado";
}

/** Estados de una propuesta. `proposed` es la única viva. */
export const PROPOSAL_STATUSES = ["proposed", "applied", "dismissed"] as const;
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];

/** Cita de la transcripción que respalda una propuesta (dato privado §17). */
export interface ProposalQuoteDTO {
    quote: string;
    startSec: number;
    endSec: number;
}

export interface ProposalDTO {
    id: string;
    questionId: string;
    runId: string;
    coverage: CoverageLevel;
    /** null salvo que la cobertura sea `abordado_*`. */
    proposedScore: number | null;
    proposedNotes: string | null;
    /** Citas verificadas contra la transcripción; puede estar vacío. */
    evidence: ProposalQuoteDTO[];
    confidence: number | null;
    status: ProposalStatus;
    createdAt: string;
    resolvedAt: string | null;
}

/**
 * Parsea la columna `evidence`. Defensivo a propósito: es JSON escrito por
 * nosotros, pero una fila corrupta no debe tumbar la pantalla del candidato.
 * Lo que no encaje se descarta en silencio.
 */
export function parseEvidence(raw: string | null): ProposalQuoteDTO[] {
    if (!raw) {
        return [];
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return [];
    }
    if (!Array.isArray(parsed)) {
        return [];
    }
    return parsed
        .filter((item): item is ProposalQuoteDTO => {
            if (typeof item !== "object" || item === null) {
                return false;
            }
            const record = item as Record<string, unknown>;
            return (
                typeof record.quote === "string" &&
                typeof record.startSec === "number" &&
                typeof record.endSec === "number"
            );
        })
        .slice(0, MAX_QUOTES_PER_PROPOSAL)
        .map((item) => ({
            quote: item.quote.slice(0, MAX_QUOTE_CHARS),
            startSec: item.startSec,
            endSec: item.endSec,
        }));
}

export function toProposalDTO(row: ProposalRow): ProposalDTO {
    return {
        id: row.id,
        questionId: row.question_id,
        runId: row.run_id,
        coverage: row.coverage,
        proposedScore: row.proposed_score,
        proposedNotes: row.proposed_notes,
        evidence: parseEvidence(row.evidence),
        confidence: row.confidence,
        status: row.status,
        createdAt: row.created_at,
        resolvedAt: row.resolved_at,
    };
}

/** Una pista guardada, tal y como se expone. Sin rutas de disco. */
export interface RecordingTrackDTO {
    label: string;
    speaker: "candidato" | "sala";
    bytes: number;
}

/**
 * Grabación conservada (§24, 2026-08-10). Nunca expone la ruta del archivo:
 * el audio no se sirve por ninguna ruta, igual que el CV original.
 */
export interface RecordingDTO {
    id: string;
    createdAt: string;
    candidateSource: "mic" | "tab";
    tracks: RecordingTrackDTO[];
    /** Bytes que ocupa AHORA en disco, medidos, no los que se subieron. */
    bytes: number;
    /**
     * Si hay transcripción guardada. Cuando es `true`, reanalizar se salta
     * whisper; cuando es `false`, el intento anterior murió antes de acabarla.
     */
    hasTranscript: boolean;
    durationSec: number | null;
    segments: number | null;
    lastRunId: string | null;
    /**
     * Estado DERIVADO del último análisis. La fila solo sabe decir `running`;
     * es el registro de jobs en memoria quien distingue si ese job sigue en
     * cola (`queued`), corriendo (`running`) o murió con el proceso
     * (`interrupted`, la señal de "reintenta"). Hasta el 2026-08-15 la
     * pantalla enseñaba "interrumpido" también mientras corría de verdad.
     */
    lastStatus:
        | "queued"
        | "running"
        | "interrupted"
        | "done"
        | "failed"
        | "cancelled"
        | null;
    /** Código tipado del último fallo. Nunca un mensaje con contenido. */
    lastErrorCode: string | null;
    /**
     * Job vivo (en cola o corriendo) sobre esta grabación, si lo hay. Permite
     * que la pantalla vuelva a engancharse al progreso tras recargar.
     */
    activeJobId: string | null;
}

/** Lo que el DTO necesita saber del registro de jobs, sin acoplarse a él. */
export interface LiveJobLookup {
    /** Estado del job si sigue vivo; `undefined` si no está en memoria. */
    liveStatus(jobId: string): "queued" | "running" | undefined;
}

export function toRecordingDTO(
    row: RecordingRow,
    tracks: StoredTrack[],
    bytes: number,
    jobs?: LiveJobLookup,
): RecordingDTO {
    const live =
        row.last_run_id && jobs ? jobs.liveStatus(row.last_run_id) : undefined;
    const lastStatus: RecordingDTO["lastStatus"] =
        row.last_status === "running" ? (live ?? "interrupted") : row.last_status;
    return {
        id: row.id,
        createdAt: row.created_at,
        candidateSource: row.candidate_source,
        tracks: tracks.map((track) => ({
            label: track.label,
            speaker: track.speaker,
            bytes: track.bytes,
        })),
        bytes,
        hasTranscript: row.transcript_at !== null,
        durationSec: row.duration_sec,
        segments: row.segments,
        lastRunId: row.last_run_id,
        lastStatus,
        lastErrorCode: row.last_error_code,
        activeJobId: live ? row.last_run_id : null,
    };
}

/** Opciones del análisis, en el campo `meta` del multipart. */
export interface InterviewAnalysisOptions {
    /** Cuál de las dos pistas es la voz del candidato. */
    candidateSource: "mic" | "tab";
    /** Reevaluar también las preguntas que ya tienen nota puesta a mano. */
    includeAnswered: boolean;
}

/**
 * Parsea el campo `meta`. Llega como texto dentro de un multipart, así que
 * puede faltar o venir mal formado sin que eso sea culpa de nadie: los
 * defaults son los del caso normal (el candidato está en la videollamada y no
 * se toca lo ya puntuado a mano).
 */
export function parseAnalysisOptions(raw: unknown): InterviewAnalysisOptions {
    const defaults: InterviewAnalysisOptions = {
        candidateSource: "tab",
        includeAnswered: false,
    };
    if (raw === undefined || raw === null || raw === "") {
        return defaults;
    }
    if (typeof raw !== "string") {
        throw new AppError("INVALID_INPUT", "El campo meta no es válido.");
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        throw new AppError("INVALID_INPUT", "El campo meta no es JSON válido.");
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new AppError("INVALID_INPUT", "El campo meta no es válido.");
    }

    const record = parsed as Record<string, unknown>;
    const source = record.candidateSource;
    if (source !== undefined && source !== "mic" && source !== "tab") {
        throw new AppError(
            "INVALID_INPUT",
            'candidateSource debe ser "mic" o "tab".',
        );
    }
    const includeAnswered = record.includeAnswered;
    if (includeAnswered !== undefined && typeof includeAnswered !== "boolean") {
        throw new AppError(
            "INVALID_INPUT",
            "includeAnswered debe ser booleano.",
        );
    }

    return {
        candidateSource: source ?? defaults.candidateSource,
        includeAnswered: includeAnswered ?? defaults.includeAnswered,
    };
}

/**
 * Entrada de PATCH /candidates/:id/interview/proposals/:proposalId.
 * Solo se admite resolver una propuesta: NO se puede devolver a `proposed`
 * (sería reescribir la historia de lo que el evaluador ya decidió).
 */
export function parseProposalResolution(body: unknown): {
    status: "applied" | "dismissed";
} {
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
        throw new AppError(
            "INVALID_INPUT",
            "El cuerpo de la petición no es válido.",
        );
    }
    const status = (body as Record<string, unknown>).status;
    if (status !== "applied" && status !== "dismissed") {
        throw new AppError(
            "INVALID_INPUT",
            'status debe ser "applied" o "dismissed".',
        );
    }
    return { status };
}

/**
 * Opciones al relanzar el análisis de una grabación guardada. Llega como JSON
 * normal, no como multipart: aquí no se sube nada.
 *
 * `candidateSource` NO se puede cambiar al reanalizar: la transcripción ya
 * está atribuida a un hablante y reinterpretarla al revés convertiría lo que
 * preguntó el entrevistador en algo que "demostró" el candidato — justo el
 * falso positivo que §24 existe para evitar. Para cambiarla hay que volver a
 * subir el audio.
 */
export function parseResumeOptions(body: unknown): { includeAnswered: boolean } {
    if (body === undefined || body === null || body === "") {
        return { includeAnswered: false };
    }
    if (typeof body !== "object" || Array.isArray(body)) {
        throw new AppError(
            "INVALID_INPUT",
            "El cuerpo de la petición no es válido.",
        );
    }
    const includeAnswered = (body as Record<string, unknown>).includeAnswered;
    if (includeAnswered !== undefined && typeof includeAnswered !== "boolean") {
        throw new AppError("INVALID_INPUT", "includeAnswered debe ser booleano.");
    }
    return { includeAnswered: includeAnswered ?? false };
}
