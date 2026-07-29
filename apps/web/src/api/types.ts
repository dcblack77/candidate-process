/**
 * Espejo de los DTOs del backend (apps/api/src/<dominio>/<dominio>.dto.ts).
 * NO inventar campos: si el backend cambia un contrato, este archivo cambia
 * en el mismo commit.
 */

/** Los cinco criterios de la rúbrica (§06). Mismos nombres que el backend. */
export const CRITERIA = [
    "adaptability",
    "fundamentals",
    "depth",
    "production",
    "stack",
] as const;

export type Criterion = (typeof CRITERIA)[number];

/** Etiquetas en español de cada criterio (§06). */
export const CRITERION_LABELS: Record<Criterion, string> = {
    adaptability: "Adaptabilidad",
    fundamentals: "Fundamentos",
    depth: "Profundidad",
    production: "Producción",
    stack: "Stack",
};

/** Tipos de evidencia (§13): explícita en el CV o inferida por el modelo. */
export type EvidenceType = "explicit" | "inferred";

export interface EvidenceItem {
    text: string;
    type: EvidenceType;
}

/** Estados del análisis de un candidato (candidate.repository). */
export type AnalysisStatus =
    | "pending"
    | "extracting"
    | "summarized"
    | "analyzing"
    | "analyzed"
    | "failed";

/** Códigos de error de la API (shared/errors.ts). */
export type AppErrorCode =
    | "LIMIT_EXCEEDED"
    | "NOT_FOUND"
    | "RATE_LIMITED"
    | "INVALID_INPUT"
    | "LLM_UNAVAILABLE"
    | "FORBIDDEN"
    | "ACTIVE_PROCESS_EXISTS"
    | "FILE_TOO_LARGE"
    | "UNSUPPORTED_MEDIA_TYPE";

/** Cuerpo estándar de error: { error: { code, message } }. */
export interface ErrorResponseBody {
    error: {
        code: string;
        message: string;
    };
}

// ── Process ────────────────────────────────────────────────────────────────

export interface ProcessResponseDTO {
    id: string;
    roleTitle: string;
    roleContext: string | null;
    status: "active" | "closed";
    createdAt: string;
    closedAt: string | null;
}

/** Respuesta de POST /process/close y DELETE /process. */
export interface ProcessPurgeResponseDTO {
    deleted: true;
    candidatesDeleted: number;
    scoresDeleted: number;
    questionsDeleted: number;
}

// ── Candidates ─────────────────────────────────────────────────────────────

export interface CandidateListItemDTO {
    id: string;
    name: string;
    analysisStatus: AnalysisStatus;
    createdAt: string;
}

export interface CandidateDetailDTO extends CandidateListItemDTO {
    processId: string;
    cvSummary: unknown;
    cvEvidence: unknown;
    score: CandidateScoreDTO | null;
    questions: InterviewQuestionDTO[];
    /** Agregados de las notas de entrevista (§15). Siempre presente. */
    interview: InterviewSummaryDTO;
    updatedAt: string;
}

export interface CandidateDeleteResponseDTO {
    id: string;
    deleted: true;
}

/**
 * Forma que persiste el backend en cv_summary (ai/schemas/summarize-cv.ts).
 * Llega como `unknown` en CandidateDetailDTO.cvSummary; se valida a mano.
 */
export interface CvSummary {
    professional_summary: string;
    evidence: Record<Criterion, EvidenceItem[]>;
    technology_transitions: string[];
    doubts_for_interview: string[];
    risks: string[];
}

/**
 * Forma persistida en candidate_score.evidence_summary
 * (scoring/analyze-candidate.usecase.ts). Llega como `unknown`.
 */
export interface EvidenceSummary {
    criteria: Record<Criterion, { rationale: string; evidence: EvidenceItem[] }>;
    doubts: string[];
    risks: string[];
}

// ── CV ─────────────────────────────────────────────────────────────────────

export interface CvExtractResponseDTO {
    candidateId: string;
    analysisStatus: AnalysisStatus;
    extractedChars: number;
    truncated: boolean;
    cvSummary: unknown;
    fileDeleted: true;
}

// ── Scoring ────────────────────────────────────────────────────────────────

export interface SuggestedCriterionScoreDTO {
    score: number;
    rationale: string;
    evidence: EvidenceItem[];
}

export interface AnalyzeResponseDTO {
    candidateId: string;
    analysisStatus: "analyzed";
    suggestedScores: Record<Criterion, SuggestedCriterionScoreDTO>;
    finalScore: number;
    confidence: number;
    doubts: string[];
    risks: string[];
    regenerationsUsed: number;
    regenerationsLimit: number;
}

export interface CandidateScoreDTO {
    candidateId: string;
    scores: Record<Criterion, number | null>;
    finalScore: number | null;
    confidence: number | null;
    evidenceSummary: unknown;
    manualNotes: string | null;
    updatedAt: string;
}

/** Entrada de PATCH /candidates/:id/score (criterios en el nivel raíz). */
export type ScorePatchBody = Partial<Record<Criterion, number>> & {
    confidence?: number;
    manualNotes?: string;
};

export interface AddNoteResponseDTO {
    candidateId: string;
    notesSaved: true;
}

// ── Questions ──────────────────────────────────────────────────────────────

export interface InterviewQuestionDTO {
    id: string;
    criterion: string;
    dimension: string;
    question: string;
    validates: string | null;
    idealAnswer: string | null;
    positiveSignals: string[];
    warningSignals: string[];
    scoringGuidance: string | null;
    createdAt: string;
    /** Nota de la respuesta (entero 1-10); null si aún no está puntuada. */
    answerScore: number | null;
    /** Notas privadas sobre la respuesta (dato sensible §17); null si no hay. */
    answerNotes: string | null;
    /** ISO 8601 del último registro de respuesta; null si no hay respuesta. */
    answeredAt: string | null;
}

export interface GenerateQuestionsResponseDTO {
    candidateId: string;
    questions: InterviewQuestionDTO[];
    questionsTotal: number;
    questionsLimit: number;
}

// ── Entrevista (§15) ───────────────────────────────────────────────────────

/** Nota mínima de la respuesta a una pregunta de entrevista. */
export const MIN_ANSWER_SCORE = 1;

/** Nota máxima (10 = la respuesta que más se ajusta a lo esperado). */
export const MAX_ANSWER_SCORE = 10;

/** Longitud máxima de las notas de una respuesta (questions.dto.ts). */
export const MAX_ANSWER_NOTES_LENGTH = 10_000;

/** Media de entrevista de un criterio y cuántas respuestas la sostienen. */
export interface CriterionInterviewDTO {
    /** Media 1-10 redondeada a 1 decimal. */
    average: number;
    /** Número de respuestas puntuadas de ese criterio. */
    answered: number;
}

/**
 * Agregados de entrevista de un candidato (scoring/interview-score.ts).
 * Siempre presentes: sin respuestas puntuadas `overall` es null y todos los
 * criterios de `byCriterion` son null.
 */
export interface InterviewSummaryDTO {
    byCriterion: Record<Criterion, CriterionInterviewDTO | null>;
    /** Global ponderado y renormalizado (1-10, 1 decimal); null si no hay notas. */
    overall: number | null;
    answeredCount: number;
    totalCount: number;
}

/**
 * Entrada de PATCH /candidates/:id/questions/:questionId/answer.
 * `score: null` borra la nota; `notes: ""` vacía el texto; un campo ausente
 * se deja como estaba. Debe llevar al menos uno de los dos.
 */
export interface AnswerQuestionBody {
    score?: number | null;
    notes?: string;
}

/** Respuesta de PATCH /candidates/:id/questions/:questionId/answer. */
export interface AnswerQuestionResponseDTO {
    candidateId: string;
    question: InterviewQuestionDTO;
    /** Agregados RECALCULADOS tras la edición: la UI los aplica sin recargar. */
    interview: InterviewSummaryDTO;
}

/** Agregados vacíos: fallback defensivo si una respuesta llega incompleta. */
export function emptyInterviewSummary(): InterviewSummaryDTO {
    const byCriterion = {} as Record<Criterion, CriterionInterviewDTO | null>;
    for (const criterion of CRITERIA) {
        byCriterion[criterion] = null;
    }
    return { byCriterion, overall: null, answeredCount: 0, totalCount: 0 };
}

// ── Ranking ────────────────────────────────────────────────────────────────

/**
 * Orden de desempate (§15, scoring/weights.ts): adaptabilidad → fundamentos →
 * producción → profundidad → stack → entrevista → confianza.
 */
export type TieBreakLevel = Criterion | "interview" | "confidence";

export interface RankingEntryDTO {
    position: number;
    candidateId: string;
    name: string;
    finalScore: number;
    scores: Record<Criterion, number>;
    confidence: number | null;
    evidenceSummary: Partial<Record<Criterion, string>>;
    pendingDoubts: string[];
    keyQuestions: string[];
    /**
     * Nota global de entrevista (1-10, 1 decimal); null sin respuestas
     * puntuadas. NO entra en finalScore: solo desempata (§15).
     */
    interviewScore: number | null;
    /** Media de entrevista por criterio; null en los criterios sin respuestas. */
    interviewByCriterion: Record<Criterion, CriterionInterviewDTO | null>;
    tieBreakApplied: TieBreakLevel | null;
    needsManualReview: boolean;
}

export interface UnscoredCandidateDTO {
    candidateId: string;
    name: string;
    analysisStatus: AnalysisStatus;
}

export interface RankingResponseDTO {
    weights: Record<Criterion, number>;
    entries: RankingEntryDTO[];
    unscored: UnscoredCandidateDTO[];
}

// ── Export ─────────────────────────────────────────────────────────────────

/** Banderas del export y sus DEFAULTS SEGUROS (export.dto.ts, §17/§19). */
export const DEFAULT_EXPORT_INCLUDE = {
    ranking: true,
    scoresByCriterion: true,
    summary: true,
    strengths: true,
    risks: true,
    questions: true,
    privateNotes: false,
    extractedText: false,
} as const;

export type ExportInclude = {
    -readonly [K in keyof typeof DEFAULT_EXPORT_INCLUDE]: boolean;
};

export interface ExportResponseDTO {
    format: "markdown";
    filename: string;
    content: string;
    exportsUsedThisSession: number;
    exportsLimit: number;
}

// ── Health ─────────────────────────────────────────────────────────────────

export interface HealthResponseDTO {
    status: "ok";
    db: boolean;
    llm: boolean;
}
