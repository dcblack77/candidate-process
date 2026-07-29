import { inject, injectable } from "@expressots/core";
import { Criterion, CRITERIA } from "../ai/schemas/common";
import {
    CandidateRepository,
    CandidateRow,
} from "../candidates/candidate.repository";
import {
    ProcessRepository,
    requireActiveProcess,
} from "../process/process.repository";
import {
    InterviewQuestionRow,
    QuestionRepository,
} from "../questions/question.repository";
import { interviewScoreOf } from "../questions/questions.dto";
import { InterviewScore } from "../scoring/interview-score";
import {
    CandidateScoreRow,
    ScoreRepository,
} from "../scoring/score.repository";
import { parseJsonColumn } from "../scoring/scoring.dto";
import {
    computeFinalScore,
    CriterionScores,
    rankEntries,
    WEIGHTS,
} from "../scoring/weights";
import { RateLimiter } from "../security/rate-limit";
import { RATE_LIMITS_PER_HOUR } from "../shared/limits";
import {
    RankingEntryDTO,
    RankingResponseDTO,
    UnscoredCandidateDTO,
} from "./ranking.dto";

/** Clave del rate limiter para el ranking (§16: 30/hora). */
export const RANKING_RATE_KEY = "ranking";

/** Número de "preguntas clave" por entrada del ranking. */
const KEY_QUESTIONS_COUNT = 3;

/**
 * GET /ranking (BLUEPRINT §15): todos los candidatos no borrados del proceso
 * activo con puntuación completa, ordenados con rankEntries (weights.ts es la
 * única fuente de pesos y desempates). Los candidatos sin puntuación se
 * listan aparte en `unscored`. Sin proceso activo → 404.
 */
@injectable()
export class GetRankingUseCase {
    constructor(
        @inject(ProcessRepository)
        private readonly processes: ProcessRepository,
        @inject(CandidateRepository)
        private readonly candidates: CandidateRepository,
        @inject(ScoreRepository) private readonly scores: ScoreRepository,
        @inject(QuestionRepository)
        private readonly questions: QuestionRepository,
        @inject(RateLimiter) private readonly rateLimiter: RateLimiter,
    ) {}

    execute(): RankingResponseDTO {
        const active = requireActiveProcess(this.processes);
        this.rateLimiter.check(RANKING_RATE_KEY, RATE_LIMITS_PER_HOUR.RANKING);

        const unscored: UnscoredCandidateDTO[] = [];
        const rankable: Array<{
            candidate: CandidateRow;
            score: CandidateScoreRow;
            scores: CriterionScores;
            finalScore: number;
            questions: InterviewQuestionRow[];
            interview: InterviewScore;
            interviewScore: number | null;
            confidence: number | null;
        }> = [];

        for (const candidate of this.candidates.listActive(active.id)) {
            const score = this.scores.findByCandidate(candidate.id);
            if (
                !score ||
                CRITERIA.some((criterion) => score[criterion] === null)
            ) {
                unscored.push({
                    candidateId: candidate.id,
                    name: candidate.name,
                    analysisStatus: candidate.analysis_status,
                });
                continue;
            }
            const criterionScores = Object.fromEntries(
                CRITERIA.map((criterion) => [
                    criterion,
                    score[criterion] as number,
                ]),
            ) as CriterionScores;
            // Las preguntas se leen una sola vez: sirven para las preguntas
            // clave y para los agregados de entrevista del desempate.
            const questions = this.questions.listByCandidate(candidate.id);
            const interview = interviewScoreOf(questions);
            rankable.push({
                candidate,
                score,
                scores: criterionScores,
                // Defensa en profundidad: se recalcula aquí también, por si la
                // fila viniera de una edición parcial antigua sin final_score.
                finalScore:
                    score.final_score ?? computeFinalScore(criterionScores),
                questions,
                interview,
                interviewScore: interview.overall,
                confidence: score.confidence,
            });
        }

        const entries: RankingEntryDTO[] = rankEntries(rankable).map(
            (entry) => ({
                position: entry.position,
                candidateId: entry.candidate.id,
                name: entry.candidate.name,
                finalScore: entry.finalScore,
                scores: entry.scores,
                confidence: entry.confidence,
                evidenceSummary: briefEvidenceSummary(entry.score),
                pendingDoubts: doubtsOf(entry.score),
                keyQuestions: entry.questions
                    .slice(0, KEY_QUESTIONS_COUNT)
                    .map((question) => question.question),
                interviewScore: entry.interviewScore,
                interviewByCriterion: entry.interview.byCriterion,
                tieBreakApplied: entry.tieBreakApplied,
                needsManualReview: entry.needsManualReview,
            }),
        );

        return { weights: WEIGHTS, entries, unscored };
    }
}

/** Forma persistida de evidence_summary: {criteria, doubts, risks}. */
interface StoredEvidenceSummary {
    criteria?: Partial<
        Record<Criterion, { rationale?: unknown; evidence?: unknown }>
    >;
    doubts?: unknown;
    risks?: unknown;
}

function storedSummary(score: CandidateScoreRow): StoredEvidenceSummary {
    const parsed = parseJsonColumn(score.evidence_summary);
    return typeof parsed === "object" && parsed !== null
        ? (parsed as StoredEvidenceSummary)
        : {};
}

/** Evidencia resumida (§15): rationale por criterio, sin listas de evidencias. */
function briefEvidenceSummary(
    score: CandidateScoreRow,
): Partial<Record<Criterion, string>> {
    const summary: Partial<Record<Criterion, string>> = {};
    const criteria = storedSummary(score).criteria ?? {};
    for (const criterion of CRITERIA) {
        const rationale = criteria[criterion]?.rationale;
        if (typeof rationale === "string" && rationale.length > 0) {
            summary[criterion] = rationale;
        }
    }
    return summary;
}

function doubtsOf(score: CandidateScoreRow): string[] {
    const { doubts } = storedSummary(score);
    return Array.isArray(doubts)
        ? doubts.filter((doubt): doubt is string => typeof doubt === "string")
        : [];
}
