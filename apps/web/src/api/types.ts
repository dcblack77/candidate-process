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

/**
 * Veredicto del CONTRASTE del CV contra la entrevista, por criterio (§13,
 * ai/schemas/score-candidate.ts). En los análisis antiguos —hechos antes de
 * que existiera el contraste— llega `null`.
 */
export type Verdict =
    | "confirmed"
    | "not_demonstrated"
    | "contradicted"
    | "not_assessed";

/** Etiquetas en español del veredicto: qué prometía el CV vs qué demostró. */
export const VERDICT_LABELS: Record<Verdict, string> = {
    confirmed: "✓ Confirmado en entrevista",
    not_demonstrated: "⚠ No demostrado",
    contradicted: "✗ Contradicho",
    not_assessed: "Sin evaluar en entrevista",
};

/** Sufijo de clase CSS del badge de cada veredicto (ver styles.css). */
export const VERDICT_CLASSES: Record<Verdict, string> = {
    confirmed: "verdict-confirmed",
    not_demonstrated: "verdict-not-demonstrated",
    contradicted: "verdict-contradicted",
    not_assessed: "verdict-not-assessed",
};

/**
 * Veredictos que NO aportan contraste: un análisis en el que todos los
 * criterios están así se hizo sin tener en cuenta la entrevista.
 */
export function isAssessedVerdict(verdict: Verdict | null): boolean {
    return verdict !== null && verdict !== "not_assessed";
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
    | "STT_UNAVAILABLE"
    | "FORBIDDEN"
    | "PROCESS_CLOSED"
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
    /** `closed` = archivado: se consulta pero no se modifica. */
    status: "active" | "closed";
    createdAt: string;
    closedAt: string | null;
    /** true si es el proceso seleccionado (sobre el que opera el resto). */
    isCurrent: boolean;
}

/**
 * Entrada de GET /process/list. Sin `roleContext` a propósito: la lista solo
 * sirve para elegir proceso.
 */
export interface ProcessListItemDTO {
    id: string;
    roleTitle: string;
    status: "active" | "closed";
    createdAt: string;
    closedAt: string | null;
    isCurrent: boolean;
    candidateCount: number;
}

/**
 * Cuerpo de PATCH /process. Al menos un campo; `roleContext: null` borra el
 * contexto del rol (el backend distingue null de ausente).
 */
export interface ProcessPatchBody {
    roleTitle?: string;
    roleContext?: string | null;
}

/** Respuesta de DELETE /process y DELETE /process/:id (borrado definitivo). */
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
    /** Propuestas VIVAS del análisis de audio (§24); vacío si no hay. */
    proposals: ProposalDTO[];
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
    criteria: Record<
        Criterion,
        {
            rationale: string;
            evidence: EvidenceItem[];
            /** Contraste CV/entrevista (§13); null en análisis antiguos. */
            verdict: Verdict | null;
        }
    >;
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

// ── Carga masiva de CVs (§16) ─────────────────────────────────────────────

export type BulkImportJobStatus = "running" | "done" | "failed" | "cancelled";

export type BulkImportItemStatus =
    | "rejected"
    | "queued"
    | "summarizing"
    | "summarized"
    | "failed"
    | "skipped"
    | "cancelled";

export interface CvBulkImportItemDTO {
    /** Posición del archivo en la subida (0-based). */
    index: number;
    /** null si el archivo se rechazó antes de crear candidato. */
    candidateId: string | null;
    name: string | null;
    status: BulkImportItemStatus;
    errorCode: string | null;
    extractedChars: number | null;
    truncated: boolean | null;
    llmWaits: number;
}

export interface CvBulkImportCountsDTO {
    total: number;
    rejected: number;
    queued: number;
    summarizing: number;
    summarized: number;
    failed: number;
    skipped: number;
    cancelled: number;
}

export interface CvBulkImportResponseDTO {
    jobId: string;
    processId: string;
    status: BulkImportJobStatus;
    startedAt: string;
    finishedAt: string | null;
    errorCode: string | null;
    cancelRequested: boolean;
    counts: CvBulkImportCountsDTO;
    items: CvBulkImportItemDTO[];
    filesDeleted: true;
}

/** Espejo de MAX_BULK_CV_FILES del backend. */
export const MAX_BULK_CV_FILES = 30;

/** Espejo de MAX_CV_MB del backend. */
export const MAX_CV_MB = 10;

// ── Scoring ────────────────────────────────────────────────────────────────

export interface SuggestedCriterionScoreDTO {
    score: number;
    rationale: string;
    evidence: EvidenceItem[];
    /** Resultado del contraste con la entrevista (§13). */
    verdict: Verdict;
}

export interface AnalyzeResponseDTO {
    candidateId: string;
    analysisStatus: "analyzed";
    suggestedScores: Record<Criterion, SuggestedCriterionScoreDTO>;
    /** Score de la RÚBRICA §06 (1-5): lo que promete el CV. */
    cvScore: number;
    /** @deprecated Alias histórico de `cvScore`; mismo valor. No usar en la UI. */
    finalScore: number;
    /** Nota global de entrevista (1-10) o null si no hay respuestas puntuadas. */
    interviewScore: number | null;
    /** Score final combinado (§06): `cvScore*0.30 + (interviewScore/2)*0.70`. */
    overallScore: number;
    /** true si el combinado es todavía solo el score de CV (sin entrevista). */
    provisional: boolean;
    confidence: number;
    doubts: string[];
    risks: string[];
    regenerationsUsed: number;
    regenerationsLimit: number;
}

export interface CandidateScoreDTO {
    candidateId: string;
    scores: Record<Criterion, number | null>;
    /** Score de la rúbrica §06 (1-5); null si falta algún criterio. */
    cvScore: number | null;
    /** @deprecated Alias histórico de `cvScore`; mismo valor. No usar en la UI. */
    finalScore: number | null;
    /** Nota global de entrevista (1-10) o null si no hay respuestas puntuadas. */
    interviewScore: number | null;
    /** Score final combinado 30% CV / 70% entrevista; null sin score de CV. */
    overallScore: number | null;
    /** true mientras el combinado sea solo el score de CV. */
    provisional: boolean;
    confidence: number | null;
    evidenceSummary: unknown;
    /**
     * Veredicto del contraste CV/entrevista por criterio (§13), extraído por
     * el backend de `evidenceSummary.criteria[*].verdict`. null en los
     * análisis antiguos, anteriores al contraste.
     */
    verdicts: Record<Criterion, Verdict | null>;
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

// ── Riesgos y lagunas (§13) ───────────────────────────────────────────────

export type RiskCategory =
    | "role_gap"
    | "exposure_without_results"
    | "unproven_transition"
    | "no_production_experience"
    | "timeline_inconsistency"
    | "single_environment"
    | "vague_claim";

export type RiskSeverity = "low" | "medium" | "high";

export interface RiskVerificationStatsDTO {
    risks: number;
    gaps: number;
    explicit: number;
    inferred: number;
    downgradedToInferred: number;
}

export interface RiskItemDTO {
    category: RiskCategory;
    criterion: Criterion;
    severity: RiskSeverity;
    concern: string;
    evidence: EvidenceItem;
    interviewCheck: string;
}

export interface GapItemDTO {
    criterion: Criterion;
    missing: string;
    whyItMatters: string;
    interviewCheck: string;
}

export interface RiskAnalysisDTO {
    risks: RiskItemDTO[];
    gaps: GapItemDTO[];
    confidence: number;
    stats: RiskVerificationStatsDTO;
    createdAt: string;
    updatedAt: string;
}

export interface DetectRisksResponseDTO {
    candidateId: string;
    analysis: RiskAnalysisDTO;
    regenerationsUsed: number;
    regenerationsLimit: number;
}

export interface GetRisksResponseDTO {
    candidateId: string;
    analysis: RiskAnalysisDTO | null;
    regenerationsUsed: number;
    regenerationsLimit: number;
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

/** Respuesta de DELETE /candidates/:id/questions/:questionId. */
export interface DeleteQuestionResponseDTO {
    id: string;
    deleted: true;
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

// ── Entrevista asistida por audio (§24) ────────────────────────────────────

/**
 * Hasta qué punto el candidato abordó el tema de una pregunta.
 * `mencionado` NO es cobertura: nombrar el tema de pasada no demuestra nada.
 */
export type CoverageLevel =
    | "no_abordado"
    | "mencionado"
    | "abordado_parcial"
    | "abordado_demostrado";

/** Etiquetas en español de cada nivel de cobertura. */
export const COVERAGE_LABELS: Record<CoverageLevel, string> = {
    no_abordado: "No abordado",
    mencionado: "Solo mencionado",
    abordado_parcial: "Abordado en parte",
    abordado_demostrado: "Abordado y demostrado",
};

/** Sufijo de clase CSS del badge de cada nivel (ver styles.css). */
export const COVERAGE_CLASSES: Record<CoverageLevel, string> = {
    no_abordado: "coverage-none",
    mencionado: "coverage-mentioned",
    abordado_parcial: "coverage-partial",
    abordado_demostrado: "coverage-demonstrated",
};

export type ProposalStatus = "proposed" | "applied" | "dismissed";

/**
 * Cita literal de la transcripción que respalda una propuesta. Es el único
 * texto de la entrevista que se persiste; sin ella el evaluador no podría
 * auditar de dónde salió la nota sugerida.
 */
export interface ProposalQuoteDTO {
    quote: string;
    startSec: number;
    endSec: number;
}

/** Una pista guardada de una grabación (§24). */
export interface RecordingTrackDTO {
    label: string;
    speaker: "candidato" | "sala";
    bytes: number;
}

/**
 * Grabación de entrevista conservada en el servidor (§24, 2026-08-10).
 *
 * Existe para que un análisis que se cae se pueda reintentar sin repetir la
 * entrevista. Nunca trae rutas de disco ni una URL del audio: el audio no se
 * sirve desde ninguna parte, solo se reanaliza o se borra.
 */
export interface RecordingDTO {
    id: string;
    createdAt: string;
    candidateSource: "mic" | "tab";
    tracks: RecordingTrackDTO[];
    bytes: number;
    /** Con transcripción guardada, reanalizar se salta la transcripción. */
    hasTranscript: boolean;
    durationSec: number | null;
    segments: number | null;
    lastRunId: string | null;
    lastStatus:
        | "queued"
        | "running"
        | "interrupted"
        | "done"
        | "failed"
        | "cancelled"
        | null;
    lastErrorCode: string | null;
    /** Job vivo (en cola o corriendo), para reenganchar el polling. */
    activeJobId: string | null;
}

/** Estado de un análisis de audio en curso o terminado (§24). */
export interface InterviewAnalysisDTO {
    candidateId: string;
    jobId: string;
    /** Grabación sobre la que corre; permite reintentar tras un reinicio. */
    recordingId: string;
    status: "queued" | "running" | "done" | "failed" | "cancelled";
    /** Posición 1-based mientras espera; null cuando ya corre o terminó. */
    queuePosition: number | null;
    phase: "transcribing" | "routing" | "assessing" | "done";
    progress: { done: number; total: number };
    startedAt: string;
    finishedAt: string | null;
    stats: {
        durationSec: number;
        segments: number;
        chunks: number;
        questionsAssessed: number;
        llmCalls: number;
        demoted: number;
        routingFailures: number;
    } | null;
    error: { code: string; message: string } | null;
    proposals: ProposalDTO[];
}

/** Etiqueta de la fase, para la barra de progreso. */
export const PHASE_LABELS: Record<InterviewAnalysisDTO["phase"], string> = {
    transcribing: "Transcribiendo el audio",
    routing: "Localizando los temas",
    assessing: "Evaluando cada pregunta",
    done: "Terminado",
};

export interface ProposalDTO {
    id: string;
    questionId: string;
    runId: string;
    coverage: CoverageLevel;
    /** null salvo que la cobertura sea `abordado_*`. */
    proposedScore: number | null;
    proposedNotes: string | null;
    evidence: ProposalQuoteDTO[];
    confidence: number | null;
    status: ProposalStatus;
    createdAt: string;
    resolvedAt: string | null;
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
    /** Score de la RÚBRICA §06 (1-5): lo que promete el CV. */
    cvScore: number;
    /** @deprecated Alias histórico de `cvScore`; mismo valor. No usar en la UI. */
    finalScore: number;
    /**
     * Score final COMBINADO (§06): `cvScore*0.30 + (interviewScore/2)*0.70`.
     * Es el valor por el que el backend ORDENA el ranking.
     */
    overallScore: number;
    /**
     * true si el candidato aún no tiene entrevista puntuada: `overallScore`
     * es solo su score de CV y todavía no es comparable con los entrevistados
     * (no se le penaliza, pero su score no es definitivo).
     */
    provisional: boolean;
    scores: Record<Criterion, number>;
    confidence: number | null;
    evidenceSummary: Partial<Record<Criterion, string>>;
    pendingDoubts: string[];
    keyQuestions: string[];
    /**
     * Nota global de entrevista (1-10, 1 decimal); null sin respuestas
     * puntuadas. NO entra en `cvScore` (rúbrica) pero sí en `overallScore`
     * con el peso de `scoreWeights.interview`, y sigue desempatando (§15).
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

/**
 * Pesos del score final combinado (§06): CV vs entrevista. Única fuente:
 * `scoring/weights.ts` del backend. La UI NUNCA los hardcodea.
 */
export interface ScoreWeightsDTO {
    cv: number;
    interview: number;
}

export interface RankingResponseDTO {
    /** Pesos de los cinco criterios de la rúbrica (score de CV). */
    weights: Record<Criterion, number>;
    /** Pesos del combinado CV/entrevista del score final. */
    scoreWeights: ScoreWeightsDTO;
    entries: RankingEntryDTO[];
    unscored: UnscoredCandidateDTO[];
}

// ── Comparación cualitativa (§15/§21) ─────────────────────────────────────

export interface ComparedCandidateDTO {
    ref: string;
    candidateId: string;
    name: string;
    scores: Record<Criterion, number>;
    cvScore: number;
    overallScore: number;
    provisional: boolean;
    confidence: number | null;
    interviewScore: number | null;
    interviewByCriterion: Record<Criterion, CriterionInterviewDTO | null>;
    verdicts: Record<Criterion, Verdict | null>;
    pendingDoubts: string[];
}

export interface CriterionComparisonDTO {
    leaders: string[];
    analysis: string;
}

export interface ComparisonTieDTO {
    candidateIds: string[];
    whatWouldSeparate: string;
}

export interface ComparisonAnalysisDTO {
    criteria: Record<Criterion, CriterionComparisonDTO>;
    evidenceQuality: string;
    profiles: string;
    ties: ComparisonTieDTO[];
    openQuestions: string[];
    summary: string;
}

export interface ComparisonResponseDTO {
    processId: string;
    roleTitle: string;
    generatedAt: string;
    weights: Record<Criterion, number>;
    candidates: ComparedCandidateDTO[];
    comparison: ComparisonAnalysisDTO;
    disclaimer: string;
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

/**
 * Formatos de POST /export (§19). `markdown` es el default histórico;
 * `structured` devuelve los mismos datos en JSON para la vista de impresión
 * del navegador (de ahí sale el PDF: no hay generador de PDF en el backend).
 */
export type ExportFormat = "markdown" | "structured";

export interface ExportResponseDTO {
    format: "markdown";
    filename: string;
    content: string;
    exportsUsedThisSession: number;
    exportsLimit: number;
}

/** Pregunta recomendada dentro del export estructurado. */
export interface ExportQuestionDTO {
    question: string;
    /** Nota 1-10 de la respuesta; null si no está puntuada. */
    answerScore: number | null;
    /**
     * Texto de la respuesta (dato privado §17): el backend lo envía SOLO con
     * `include.privateNotes=true`; en cualquier otro caso llega null.
     */
    answerNotes: string | null;
}

/** Ficha de un candidato en el export estructurado. */
export interface ExportCandidateDTO {
    position: number;
    name: string;
    /** Score de la rúbrica (1-5): lo que promete el CV. */
    cvScore: number;
    /** Score final combinado CV/entrevista: el que ordena. */
    overallScore: number;
    provisional: boolean;
    /** null si se excluyó "Puntuaciones por criterio". */
    scores: Record<Criterion, number> | null;
    /** null si se excluyó "Puntuaciones por criterio". */
    verdicts: Record<Criterion, Verdict | null> | null;
    confidence: number | null;
    needsManualReview: boolean;
    summary: string | null;
    strengths: string[];
    risks: string[];
    /** Dudas pendientes de validar en entrevista (van con los riesgos). */
    doubts: string[];
    questions: ExportQuestionDTO[];
    interview: InterviewSummaryDTO;
    /** Notas del evaluador: solo con `include.privateNotes=true`; si no, null. */
    manualNotes: string | null;
}

/**
 * Respuesta de POST /export con `format: "structured"`: los datos ya
 * filtrados por `include` que la vista de impresión maqueta con React.
 *
 * NUNCA se renderiza markdown como HTML a partir de esto: el contenido viene
 * del modelo y del CV y podría traer sintaxis maliciosa (enlaces o imágenes
 * de exfiltración). Todo se pinta como texto con el escapado de React.
 */
export interface ExportStructuredResponseDTO {
    format: "structured";
    /** Nombre sugerido del PDF (`export-<slug>-<fecha>.pdf`). */
    filename: string;
    /** Marca de tiempo ISO de la generación. */
    generatedAt: string;
    roleTitle: string;
    roleContext: string | null;
    /** Pesos de la rúbrica (única fuente: el backend). */
    weights: Record<Criterion, number>;
    /** Pesos del combinado CV/entrevista (misma única fuente). */
    scoreWeights: ScoreWeightsDTO;
    entries: ExportCandidateDTO[];
    /** Nombres de los candidatos sin puntuación completa. */
    unscored: string[];
    /** Banderas aplicadas: la portada avisa si lleva información privada. */
    include: ExportInclude;
    exportsUsedThisSession: number;
    exportsLimit: number;
}

// ── Health ─────────────────────────────────────────────────────────────────

export interface HealthResponseDTO {
    status: "ok";
    db: boolean;
    llm: boolean;
    /** Servicio local de transcripción (§24). */
    stt: boolean;
}
