import { inject, injectable } from "@expressots/core";
import { LlmClient } from "../ai/llm-client";
import { CRITERIA } from "../ai/schemas/common";
import {
    SCORE_CANDIDATE_JSON_SCHEMA,
    ScoreCandidateResult,
    scoreCandidateZodSchema,
} from "../ai/schemas/score-candidate";
import { CandidateRepository } from "../candidates/candidate.repository";
import {
    ProcessRepository,
    requireActiveProcess,
} from "../process/process.repository";
import { RateLimiter } from "../security/rate-limit";
import { AuditRepository } from "../shared/audit";
import { AppError } from "../shared/errors";
import { assertValidId } from "../shared/ids";
import {
    MAX_ANALYSIS_REGENERATIONS,
    RATE_LIMITS_PER_HOUR,
} from "../shared/limits";
import { ScoreRepository } from "./score.repository";
import { AnalyzeResponseDTO } from "./scoring.dto";
import { computeFinalScore, CriterionScores } from "./weights";

/** Nombre del prompt de análisis (prompts/score-candidate.md). */
const SCORE_PROMPT = "score-candidate";

/** Clave del rate limiter para el análisis (§16: 30/hora). */
export const ANALYZE_RATE_KEY = "analyze";

/** Acción de auditoría cuyo conteo por candidato limita las regeneraciones. */
export const ANALYZED_ACTION = "candidate.analyzed";

/** Texto neutro cuando el proceso no tiene role_context. */
const NEUTRAL_ROLE_CONTEXT = "(Sin contexto adicional del rol.)";

/**
 * POST /candidates/:id/analyze (BLUEPRINT §05, §11, §13).
 *
 * - Usa el `cv_summary` persistido; el texto crudo del CV ya no existe.
 *   DECISIÓN: sin cv_summary se responde 400 INVALID_INPUT con mensaje claro
 *   (el plan sugería 409, pero el único código 409 existente es
 *   ACTIVE_PROCESS_EXISTS y no aplica; no se añade un código nuevo).
 * - Límite §16: 5 regeneraciones por candidato, contadas como eventos
 *   'candidate.analyzed' de ese entity_id. La 6ª → 422 LIMIT_EXCEEDED.
 * - El backend RECALCULA finalScore con scoring/weights.ts; cualquier
 *   aritmética del modelo se ignora (el schema ni siquiera la admite).
 * - Fallo del modelo → analysis_status='failed', reintentable.
 */
@injectable()
export class AnalyzeCandidateUseCase {
    constructor(
        @inject(ProcessRepository)
        private readonly processes: ProcessRepository,
        @inject(CandidateRepository)
        private readonly candidates: CandidateRepository,
        @inject(ScoreRepository) private readonly scores: ScoreRepository,
        @inject(RateLimiter) private readonly rateLimiter: RateLimiter,
        @inject(LlmClient) private readonly llm: LlmClient,
        @inject(AuditRepository) private readonly audit: AuditRepository,
    ) {}

    async execute(id: unknown): Promise<AnalyzeResponseDTO> {
        assertValidId(id);
        const active = requireActiveProcess(this.processes);
        const candidate = this.candidates.findActiveInProcess(id, active.id);
        if (!candidate) {
            throw new AppError("NOT_FOUND");
        }
        if (!candidate.cv_summary) {
            throw new AppError(
                "INVALID_INPUT",
                "El candidato aún no tiene resumen de CV: ejecuta antes la extracción (/cv/extract).",
            );
        }

        const regenerationsUsed = this.audit.countByActionAndEntity(
            ANALYZED_ACTION,
            id,
        );
        if (regenerationsUsed >= MAX_ANALYSIS_REGENERATIONS) {
            throw new AppError(
                "LIMIT_EXCEEDED",
                "Se alcanzó el máximo de regeneraciones de análisis para este candidato.",
            );
        }

        this.rateLimiter.check(ANALYZE_RATE_KEY, RATE_LIMITS_PER_HOUR.ANALYZE);

        const startedAt = Date.now();
        this.candidates.setAnalysisStatus(id, "analyzing");

        let analysis: ScoreCandidateResult;
        try {
            analysis = await this.llm.complete<ScoreCandidateResult>({
                promptName: SCORE_PROMPT,
                variables: {
                    cv_summary_json: candidate.cv_summary,
                    role_title: active.role_title,
                    role_context: active.role_context ?? NEUTRAL_ROLE_CONTEXT,
                },
                schema: SCORE_CANDIDATE_JSON_SCHEMA,
                zodSchema: scoreCandidateZodSchema,
            });
        } catch (error) {
            // Estado reintentable; el error viaja intacto al handler central.
            this.candidates.setAnalysisStatus(id, "failed");
            throw error;
        }

        // El score final lo calcula SIEMPRE el backend (weights.ts es la
        // única fuente): se ignora cualquier aritmética del modelo.
        const suggested = Object.fromEntries(
            CRITERIA.map((criterion) => [
                criterion,
                analysis.scores[criterion].score,
            ]),
        ) as CriterionScores;
        const finalScore = computeFinalScore(suggested);

        // evidence_summary: dudas, riesgos y rationale+evidencias por criterio.
        const evidenceSummary = {
            criteria: Object.fromEntries(
                CRITERIA.map((criterion) => [
                    criterion,
                    {
                        rationale: analysis.scores[criterion].rationale,
                        evidence: analysis.scores[criterion].evidence,
                    },
                ]),
            ),
            doubts: analysis.doubts,
            risks: analysis.risks,
        };

        this.scores.upsertAnalysis(id, {
            scores: suggested,
            finalScore,
            confidence: analysis.confidence,
            evidenceSummaryJson: JSON.stringify(evidenceSummary),
        });
        this.candidates.setAnalysisStatus(id, "analyzed");

        // Auditoría sin contenido (§17): el propio evento cuenta la regeneración.
        this.audit.logEvent(ANALYZED_ACTION, "candidate", id, {
            regeneration: regenerationsUsed + 1,
            confidence: analysis.confidence,
            durationMs: Date.now() - startedAt,
        });

        return {
            candidateId: id,
            analysisStatus: "analyzed",
            suggestedScores: analysis.scores,
            finalScore,
            confidence: analysis.confidence,
            doubts: analysis.doubts,
            risks: analysis.risks,
            regenerationsUsed: regenerationsUsed + 1,
            regenerationsLimit: MAX_ANALYSIS_REGENERATIONS,
        };
    }
}
