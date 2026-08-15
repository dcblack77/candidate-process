import {
    AddNoteResponseDTO,
    AnalyzeResponseDTO,
    AnswerQuestionBody,
    AnswerQuestionResponseDTO,
    CandidateDeleteResponseDTO,
    CandidateDetailDTO,
    CandidateListItemDTO,
    CandidateScoreDTO,
    ComparisonResponseDTO,
    CvBulkImportResponseDTO,
    CvExtractResponseDTO,
    DeleteQuestionResponseDTO,
    DetectRisksResponseDTO,
    ExportInclude,
    ExportResponseDTO,
    ExportStructuredResponseDTO,
    GenerateQuestionsResponseDTO,
    GetRisksResponseDTO,
    HealthResponseDTO,
    InterviewAnalysisDTO,
    ProcessListItemDTO,
    ProposalDTO,
    ProcessPatchBody,
    ProcessPurgeResponseDTO,
    ProcessResponseDTO,
    RankingResponseDTO,
    RecordingDTO,
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
        throw new ApiError(
            NETWORK_ERROR_CODE,
            "No se pudo contactar con la API local.",
            0,
        );
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
                ? (body as { error: { code?: unknown; message?: unknown } })
                      .error
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
    /** El proceso seleccionado. 404 NOT_FOUND si todavía no hay ninguno. */
    getProcess(): Promise<ProcessResponseDTO> {
        return request("/process");
    },
    /** Todos los procesos, abiertos y archivados, para poder cambiar. */
    listProcesses(): Promise<ProcessListItemDTO[]> {
        return request("/process/list");
    },
    /** Crea un proceso nuevo SIN cerrar los anteriores y lo deja seleccionado. */
    createProcess(input: {
        roleTitle: string;
        roleContext?: string;
    }): Promise<ProcessResponseDTO> {
        return request("/process", jsonInit("POST", input));
    },
    updateProcess(input: ProcessPatchBody): Promise<ProcessResponseDTO> {
        return request("/process", jsonInit("PATCH", input));
    },
    /**
     * Cambia el proceso seleccionado. OJO: es estado de servidor compartido —
     * afecta a cualquier otro navegador que esté usando la aplicación.
     */
    selectProcess(id: string): Promise<ProcessResponseDTO> {
        return request(
            `/process/${encodeURIComponent(id)}/select`,
            jsonInit("POST"),
        );
    },
    /** Archiva el proceso seleccionado: pasa a solo lectura, sin borrar nada. */
    closeProcess(): Promise<ProcessResponseDTO> {
        return request("/process/close", jsonInit("POST"));
    },
    /** Devuelve un proceso archivado a estado abierto. */
    reopenProcess(id: string): Promise<ProcessResponseDTO> {
        return request(
            `/process/${encodeURIComponent(id)}/reopen`,
            jsonInit("POST"),
        );
    },
    /** Borrado DEFINITIVO de un proceso y todos sus datos derivados. */
    deleteProcess(id: string): Promise<ProcessPurgeResponseDTO> {
        return request(
            `/process/${encodeURIComponent(id)}`,
            jsonInit("DELETE", { confirmDelete: true }),
        );
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
    /**
     * Sube varios CVs de golpe. `names[i]` es el nombre elegido para el
     * archivo i, o null para deducirlo del nombre del archivo.
     */
    startBulkCvImport(
        files: File[],
        names: Array<string | null>,
    ): Promise<CvBulkImportResponseDTO> {
        const form = new FormData();
        if (names.some((name) => name !== null)) {
            form.append("names", JSON.stringify(names));
        }
        for (const file of files) {
            form.append("files", file);
        }
        return request("/candidates/cv/bulk", {
            method: "POST",
            body: form,
        });
    },
    getBulkCvImport(jobId: string): Promise<CvBulkImportResponseDTO> {
        return request(`/candidates/cv/bulk/${encodeURIComponent(jobId)}`);
    },
    cancelBulkCvImport(jobId: string): Promise<CvBulkImportResponseDTO> {
        return request(`/candidates/cv/bulk/${encodeURIComponent(jobId)}`, {
            method: "DELETE",
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
    detectCandidateRisks(id: string): Promise<DetectRisksResponseDTO> {
        return request(`/candidates/${encodeURIComponent(id)}/risks`, {
            method: "POST",
        });
    },
    getCandidateRisks(id: string): Promise<GetRisksResponseDTO> {
        return request(`/candidates/${encodeURIComponent(id)}/risks`);
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
    deleteQuestion(
        candidateId: string,
        questionId: string,
    ): Promise<DeleteQuestionResponseDTO> {
        return request(
            `/candidates/${encodeURIComponent(candidateId)}/questions/${encodeURIComponent(questionId)}`,
            {
                method: "DELETE",
            },
        );
    },

    // ── Entrevista asistida por audio (§24) ───────────────────────────────
    /**
     * Sube las pistas y lanza el análisis. Responde 202 enseguida: el trabajo
     * dura minutos y se sigue con `getInterviewAnalysis`.
     */
    startInterviewAnalysis(
        candidateId: string,
        tracks: { mic?: Blob; tab?: Blob },
        meta: { candidateSource: "mic" | "tab"; includeAnswered?: boolean },
    ): Promise<InterviewAnalysisDTO> {
        const form = new FormData();
        if (tracks.mic) {
            form.append("mic", tracks.mic, "mic.webm");
        }
        if (tracks.tab) {
            form.append("tab", tracks.tab, "tab.webm");
        }
        form.append("meta", JSON.stringify(meta));
        return request(
            `/candidates/${encodeURIComponent(candidateId)}/interview/analysis`,
            {
                method: "POST",
                body: form,
            },
        );
    },
    getInterviewAnalysis(
        candidateId: string,
        jobId: string,
    ): Promise<InterviewAnalysisDTO> {
        return request(
            `/candidates/${encodeURIComponent(candidateId)}/interview/analysis/${encodeURIComponent(jobId)}`,
        );
    },
    cancelInterviewAnalysis(
        candidateId: string,
        jobId: string,
    ): Promise<InterviewAnalysisDTO> {
        return request(
            `/candidates/${encodeURIComponent(candidateId)}/interview/analysis/${encodeURIComponent(jobId)}`,
            { method: "DELETE" },
        );
    },
    /** Grabaciones conservadas de un candidato (§24). */
    listRecordings(
        candidateId: string,
    ): Promise<{ recordings: RecordingDTO[] }> {
        return request(
            `/candidates/${encodeURIComponent(candidateId)}/interview/recordings`,
        );
    },
    /**
     * Relanza el análisis sobre una grabación ya guardada. Sin subida: si hay
     * transcripción guardada ni siquiera se vuelve a transcribir.
     */
    resumeInterviewAnalysis(
        candidateId: string,
        recordingId: string,
        options: { includeAnswered?: boolean } = {},
    ): Promise<InterviewAnalysisDTO> {
        return request(
            `/candidates/${encodeURIComponent(candidateId)}/interview/analysis/from/${encodeURIComponent(recordingId)}`,
            jsonInit("POST", options),
        );
    },
    /** Borra una grabación: archivos y fila. Irreversible. */
    deleteRecording(
        candidateId: string,
        recordingId: string,
    ): Promise<{ id: string; deleted: true }> {
        return request(
            `/candidates/${encodeURIComponent(candidateId)}/interview/recordings/${encodeURIComponent(recordingId)}`,
            { method: "DELETE" },
        );
    },
    /**
     * Marca una propuesta como aplicada o descartada. OJO: esto NO escribe la
     * nota — aplicar es mandar antes el PATCH de la respuesta de siempre.
     */
    resolveProposal(
        candidateId: string,
        proposalId: string,
        status: "applied" | "dismissed",
    ): Promise<{ proposal: ProposalDTO }> {
        return request(
            `/candidates/${encodeURIComponent(candidateId)}/interview/proposals/${encodeURIComponent(proposalId)}`,
            jsonInit("PATCH", { status }),
        );
    },

    // ── Ranking / export ──────────────────────────────────────────────────
    getRanking(): Promise<RankingResponseDTO> {
        return request("/ranking");
    },
    compareCandidates(candidateIds: string[]): Promise<ComparisonResponseDTO> {
        return request("/comparison", jsonInit("POST", { candidateIds }));
    },
    /** Export en markdown: vista previa y descarga (§19). */
    exportReport(include: ExportInclude): Promise<ExportResponseDTO> {
        return request(
            "/export",
            jsonInit("POST", { format: "markdown", include }),
        );
    },
    /**
     * Export estructurado para la vista de impresión (§19). Consume una
     * unidad del límite de exportaciones igual que el markdown: la UI lo
     * llama UNA vez y pasa el resultado a /export/print.
     */
    exportStructured(
        include: ExportInclude,
    ): Promise<ExportStructuredResponseDTO> {
        return request(
            "/export",
            jsonInit("POST", { format: "structured", include }),
        );
    },
};
