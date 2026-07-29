import {
    AddNoteResponseDTO,
    AnalyzeResponseDTO,
    AnswerQuestionBody,
    AnswerQuestionResponseDTO,
    CandidateDeleteResponseDTO,
    CandidateDetailDTO,
    CandidateListItemDTO,
    CandidateScoreDTO,
    CvExtractResponseDTO,
    ExportInclude,
    ExportResponseDTO,
    GenerateQuestionsResponseDTO,
    HealthResponseDTO,
    ProcessPurgeResponseDTO,
    ProcessResponseDTO,
    RankingResponseDTO,
    ScorePatchBody,
} from "./types";

/**
 * Cliente HTTP tipado de la API local. Todas las rutas van con prefijo /api
 * (el proxy de Vite lo quita y reenvía a 127.0.0.1:3010).
 *
 * Los errores del backend llegan como { error: { code, message } } y se
 * convierten en ApiError; la UI los traduce a mensajes amigables en
 * errors.ts (nunca muestra datos técnicos crudos).
 */

export class ApiError extends Error {
    readonly code: string;
    readonly httpStatus: number;

    constructor(code: string, message: string, httpStatus: number) {
        super(message);
        this.name = "ApiError";
        this.code = code;
        this.httpStatus = httpStatus;
    }
}

/** Código genérico cuando la API no responde o responde algo no parseable. */
export const NETWORK_ERROR_CODE = "NETWORK_ERROR";

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
    let response: Response;
    try {
        response = await fetch(`/api${path}`, init);
    } catch {
        throw new ApiError(NETWORK_ERROR_CODE, "No se pudo contactar con la API local.", 0);
    }

    let body: unknown = null;
    try {
        body = await response.json();
    } catch {
        body = null;
    }

    if (!response.ok) {
        const error =
            typeof body === "object" && body !== null && "error" in body
                ? (body as { error: { code?: unknown; message?: unknown } }).error
                : null;
        const code =
            error && typeof error.code === "string" ? error.code : "UNKNOWN";
        const message =
            error && typeof error.message === "string"
                ? error.message
                : "Error inesperado de la API.";
        throw new ApiError(code, message, response.status);
    }

    return body as T;
}

function jsonInit(method: string, payload?: unknown): RequestInit {
    const init: RequestInit = { method };
    if (payload !== undefined) {
        init.headers = { "Content-Type": "application/json" };
        init.body = JSON.stringify(payload);
    }
    return init;
}

export const api = {
    // ── Health ────────────────────────────────────────────────────────────
    health(): Promise<HealthResponseDTO> {
        return request("/health");
    },

    // ── Process ───────────────────────────────────────────────────────────
    getProcess(): Promise<ProcessResponseDTO> {
        return request("/process");
    },
    createProcess(input: {
        roleTitle: string;
        roleContext?: string;
    }): Promise<ProcessResponseDTO> {
        return request("/process", jsonInit("POST", input));
    },
    closeProcess(): Promise<ProcessPurgeResponseDTO> {
        return request("/process/close", jsonInit("POST", { confirmDelete: true }));
    },

    // ── Candidates ────────────────────────────────────────────────────────
    listCandidates(): Promise<CandidateListItemDTO[]> {
        return request("/candidates");
    },
    createCandidate(name: string): Promise<CandidateListItemDTO> {
        return request("/candidates", jsonInit("POST", { name }));
    },
    getCandidate(id: string): Promise<CandidateDetailDTO> {
        return request(`/candidates/${encodeURIComponent(id)}`);
    },
    deleteCandidate(id: string): Promise<CandidateDeleteResponseDTO> {
        return request(`/candidates/${encodeURIComponent(id)}`, {
            method: "DELETE",
        });
    },

    // ── CV ────────────────────────────────────────────────────────────────
    /** Multipart con el archivo en el campo "file" (sin Content-Type manual). */
    extractCv(id: string, file: File): Promise<CvExtractResponseDTO> {
        const form = new FormData();
        form.append("file", file);
        return request(`/candidates/${encodeURIComponent(id)}/cv/extract`, {
            method: "POST",
            body: form,
        });
    },

    // ── Scoring / notas ───────────────────────────────────────────────────
    analyzeCandidate(id: string): Promise<AnalyzeResponseDTO> {
        return request(`/candidates/${encodeURIComponent(id)}/analyze`, {
            method: "POST",
        });
    },
    patchScore(id: string, patch: ScorePatchBody): Promise<CandidateScoreDTO> {
        return request(
            `/candidates/${encodeURIComponent(id)}/score`,
            jsonInit("PATCH", patch),
        );
    },
    addNote(id: string, notes: string): Promise<AddNoteResponseDTO> {
        return request(
            `/candidates/${encodeURIComponent(id)}/notes`,
            jsonInit("POST", { notes }),
        );
    },

    // ── Questions ─────────────────────────────────────────────────────────
    generateQuestions(
        id: string,
        count?: number,
    ): Promise<GenerateQuestionsResponseDTO> {
        return request(
            `/candidates/${encodeURIComponent(id)}/questions`,
            jsonInit("POST", count === undefined ? {} : { count }),
        );
    },
    /**
     * Registra la nota (1-10) y/o las notas de texto de una respuesta.
     * `score: null` borra la nota; `notes: ""` vacía el texto. La respuesta
     * trae los agregados de entrevista ya recalculados.
     */
    answerQuestion(
        candidateId: string,
        questionId: string,
        body: AnswerQuestionBody,
    ): Promise<AnswerQuestionResponseDTO> {
        return request(
            `/candidates/${encodeURIComponent(candidateId)}/questions/${encodeURIComponent(questionId)}/answer`,
            jsonInit("PATCH", body),
        );
    },

    // ── Ranking / export ──────────────────────────────────────────────────
    getRanking(): Promise<RankingResponseDTO> {
        return request("/ranking");
    },
    exportReport(include: ExportInclude): Promise<ExportResponseDTO> {
        return request("/export", jsonInit("POST", { include }));
    },
};
