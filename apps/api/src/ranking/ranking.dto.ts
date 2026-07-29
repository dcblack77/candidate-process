import { Criterion } from "../ai/schemas/common";
import { AnalysisStatus } from "../candidates/candidate.repository";
import { TieBreakLevel } from "../scoring/weights";

/**
 * DTOs de GET /ranking (BLUEPRINT §15).
 */

/** Entrada del ranking para un candidato puntuado. */
export interface RankingEntryDTO {
    position: number;
    candidateId: string;
    name: string;
    finalScore: number;
    scores: Record<Criterion, number>;
    confidence: number | null;
    /** Evidencia resumida: rationale breve por criterio del último análisis. */
    evidenceSummary: Partial<Record<Criterion, string>>;
    /** Dudas pendientes de validar en entrevista. */
    pendingDoubts: string[];
    /** Primeras 3 preguntas de entrevista persistidas. */
    keyQuestions: string[];
    /** Nivel de desempate que resolvió un empate de score final, si lo hubo. */
    tieBreakApplied: TieBreakLevel | null;
    /** true si el empate persiste tras la confianza (§15, paso 7). */
    needsManualReview: boolean;
}

/** Candidato sin puntuación completa: fuera del ranking, listado aparte. */
export interface UnscoredCandidateDTO {
    candidateId: string;
    name: string;
    analysisStatus: AnalysisStatus;
}

/** Respuesta de GET /ranking. */
export interface RankingResponseDTO {
    /** Pesos de la rúbrica (única fuente: scoring/weights.ts). */
    weights: Record<Criterion, number>;
    entries: RankingEntryDTO[];
    unscored: UnscoredCandidateDTO[];
}
