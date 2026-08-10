import { inject, injectable } from "@expressots/core";
import { LlmClient } from "../ai/llm-client";
import { NEUTRAL_ROLE_CONTEXT } from "../ai/role-context";
import { CRITERIA } from "../ai/schemas/common";
import {
    CriterionVerdict,
    DEFAULT_VERDICT,
    SCORE_CANDIDATE_JSON_SCHEMA,
    ScoreCandidateResult,
    scoreCandidateZodSchema,
} from "../ai/schemas/score-candidate";
import { CandidateRepository } from "../candidates/candidate.repository";
import {
    ProcessRepository,
    requireWritableProcess,
} from "../process/process.repository";
import { QuestionRepository } from "../questions/question.repository";
import { interviewScoreOf } from "../questions/questions.dto";
import { RateLimiter } from "../security/rate-limit";
import { AuditRepository } from "../shared/audit";
import { AppError } from "../shared/errors";
import { assertValidId } from "../shared/ids";
import {
    MAX_ANALYSIS_REGENERATIONS,
    RATE_LIMITS_PER_HOUR,
} from "../shared/limits";
import { buildInterviewContext } from "./interview-context";
import { ScoreRepository } from "./score.repository";
import { AnalyzeResponseDTO } from "./scoring.dto";
import {
    computeFinalScore,
    computeOverallScore,
    CriterionScores,
} from "./weights";

/** Nombre del prompt de análisis (prompts/score-candidate.md). */
const SCORE_PROMPT = "score-candidate";

/** Clave del rate limiter para el análisis (§16: 30/hora). */
export const ANALYZE_RATE_KEY = "analyze";

/** Acción de auditoría cuyo conteo por candidato limita las regeneraciones. */
export const ANALYZED_ACTION = "candidate.analyzed";

/**
 * POST /candidates/:id/analyze (BLUEPRINT §05, §11, §13).
 *
 * - Usa el `cv_summary` persistido; el texto crudo del CV ya no existe.
 *   DECISIÓN: sin cv_summary se responde 400 INVALID_INPUT con mensaje claro
 *   (el plan sugería 409, pero el único código 409 existente es
 *   ACTIVE_PROCESS_EXISTS y no aplica; no se añade un código nuevo).
 * - CONTRASTE CON LA ENTREVISTA (§13): si el candidato tiene al menos una
 *   respuesta puntuada, el prompt recibe además esa evidencia y debe BAJAR
 *   los criterios que el CV prometía y la entrevista no demostró. Sin
 *   respuestas puntuadas el comportamiento es idéntico al anterior y todos
 *   los `verdict` quedan en `not_assessed`.
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
        @inject(QuestionRepository)
        private readonly questions: QuestionRepository,
        @inject(RateLimiter) private readonly rateLimiter: RateLimiter,
        @inject(LlmClient) private readonly llm: LlmClient,
        @inject(AuditRepository) private readonly audit: AuditRepository,
    ) {}

    async execute(id: unknown): Promise<AnalyzeResponseDTO> {
        assertValidId(id);
        const selected = requireWritableProcess(this.processes);
        const candidate = this.candidates.findActiveInProcess(id, selected.id);
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

        // Evidencia de entrevista con la que contrastar el CV (§13). Las
        // preguntas se leen una sola vez: sirven para el prompt y para el
        // score combinado que devuelve la respuesta.
        const questionRows = this.questions.listByCandidate(id);
        const interviewContext = buildInterviewContext(
            questionRows.map((question) => ({
                criterion: question.criterion,
                question: question.question,
                idealAnswer: question.ideal_answer,
                answerScore: question.answer_score,
                answerNotes: question.answer_notes,
            })),
        );

        const startedAt = Date.now();
        this.candidates.setAnalysisStatus(id, "analyzing");

        let analysis: ScoreCandidateResult;
        try {
            analysis = await this.llm.complete<ScoreCandidateResult>({
                promptName: SCORE_PROMPT,
                variables: {
                    cv_summary_json: candidate.cv_summary,
                    role_title: selected.role_title,
                    role_context: selected.role_context ?? NEUTRAL_ROLE_CONTEXT,
                    interview_context: interviewContext.text,
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

        // Sin evidencia de entrevista NO hay contraste posible: se fuerza
        // `not_assessed` aunque el modelo se invente otro veredicto, para que
        // el comportamiento sea idéntico al de antes del contraste.
        const verdicts = Object.fromEntries(
            CRITERIA.map((criterion) => [
                criterion,
                interviewContext.answeredCount > 0
                    ? analysis.scores[criterion].verdict
                    : DEFAULT_VERDICT,
            ]),
        ) as Record<string, CriterionVerdict>;

        // evidence_summary: dudas, riesgos y rationale+evidencias+veredicto
        // por criterio.
        const evidenceSummary = {
            criteria: Object.fromEntries(
                CRITERIA.map((criterion) => [
                    criterion,
                    {
                        rationale: analysis.scores[criterion].rationale,
                        evidence: analysis.scores[criterion].evidence,
                        verdict: verdicts[criterion],
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

        // Auditoría sin contenido (§17): el propio evento cuenta la
        // regeneración. `interviewAnswers` es solo un conteo, no contenido.
        this.audit.logEvent(ANALYZED_ACTION, "candidate", id, {
            regeneration: regenerationsUsed + 1,
            confidence: analysis.confidence,
            interviewAnswers: interviewContext.answeredCount,
            durationMs: Date.now() - startedAt,
        });

        // Score combinado (§06): el de CV recién calculado con la nota de
        // entrevista que ya tuviera el candidato.
        const interviewScore = interviewScoreOf(questionRows).overall;
        const { overall, provisional } = computeOverallScore(
            finalScore,
            interviewScore,
        );

        return {
            candidateId: id,
            analysisStatus: "analyzed",
            suggestedScores: Object.fromEntries(
                CRITERIA.map((criterion) => [
                    criterion,
                    {
                        ...analysis.scores[criterion],
                        verdict: verdicts[criterion],
                    },
                ]),
            ) as AnalyzeResponseDTO["suggestedScores"],
            cvScore: finalScore,
            finalScore,
            interviewScore,
            overallScore: overall,
            provisional,
            confidence: analysis.confidence,
            doubts: analysis.doubts,
            risks: analysis.risks,
            regenerationsUsed: regenerationsUsed + 1,
            regenerationsLimit: MAX_ANALYSIS_REGENERATIONS,
        };
    }
}
