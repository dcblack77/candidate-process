import { Criterion } from "../ai/schemas/common";
import { AnalysisStatus } from "../candidates/candidate.repository";
import { CriterionInterviewAverage } from "../scoring/interview-score";
import { TieBreakLevel } from "../scoring/weights";

/**
 * DTOs de GET /ranking (BLUEPRINT §15).
 */

/** Entrada del ranking para un candidato puntuado. */
export interface RankingEntryDTO {
    position: number;
    candidateId: string;
    name: string;
    /** Score de la RÚBRICA §06 (1-5): lo que promete el CV. */
    cvScore: number;
    /** @deprecated Alias histórico de `cvScore`; mismo valor. */
    finalScore: number;
    /**
     * Score final COMBINADO (§06): `cvScore*0.30 + (interviewScore/2)*0.70`.
     * Es el valor por el que se ordena el ranking.
     */
    overallScore: number;
    /**
     * true si el candidato no tiene entrevista puntuada: `overallScore` es
     * solo su score de CV y todavía no es definitivo (no se le penaliza).
     */
    provisional: boolean;
    scores: Record<Criterion, number>;
    confidence: number | null;
    /** Evidencia resumida: rationale breve por criterio del último análisis. */
    evidenceSummary: Partial<Record<Criterion, string>>;
    /** Dudas pendientes de validar en entrevista. */
    pendingDoubts: string[];
    /** Primeras 3 preguntas de entrevista persistidas. */
    keyQuestions: string[];
    /**
     * Nota global de entrevista (1-10, media ponderada renormalizada sobre
     * los criterios con respuestas); null si no hay ninguna respuesta
     * puntuada. NO entra en `cvScore` (rúbrica) pero SÍ en `overallScore`
     * con peso 70% (§06), y sigue siendo nivel de desempate (§15).
     */
    interviewScore: number | null;
    /** Media de entrevista por criterio; null en los criterios sin respuestas. */
    interviewByCriterion: Record<Criterion, CriterionInterviewAverage | null>;
    /** Nivel de desempate que resolvió un empate del combinado, si lo hubo. */
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

/** Pesos del score final combinado (§06): CV vs entrevista. */
export interface ScoreWeightsDTO {
    cv: number;
    interview: number;
}

/** Respuesta de GET /ranking. */
export interface RankingResponseDTO {
    /** Pesos de los cinco criterios (única fuente: scoring/weights.ts). */
    weights: Record<Criterion, number>;
    /** Pesos del combinado CV/entrevista (misma única fuente). */
    scoreWeights: ScoreWeightsDTO;
    entries: RankingEntryDTO[];
    unscored: UnscoredCandidateDTO[];
}
