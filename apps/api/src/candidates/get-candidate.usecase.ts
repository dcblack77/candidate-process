import { inject, injectable } from "@expressots/core";
import {
    ProcessRepository,
    requireActiveProcess,
} from "../process/process.repository";
import { QuestionRepository } from "../questions/question.repository";
import { toQuestionDTO } from "../questions/questions.dto";
import { ScoreRepository } from "../scoring/score.repository";
import { toCandidateScoreDTO } from "../scoring/scoring.dto";
import { AppError } from "../shared/errors";
import { assertValidId } from "../shared/ids";
import { CandidateDetailDTO, toCandidateDetail } from "./candidate.dto";
import { CandidateRepository } from "./candidate.repository";

/**
 * GET /candidates/:id — detalle completo del candidato: cv_summary y
 * cv_evidence parseados a JSON, más su puntuación (si existe) y sus
 * preguntas de entrevista persistidas (las preguntas no tienen GET propio
 * en el blueprint §10: se sirven aquí). NOT_FOUND si no existe, está
 * soft-deleted o pertenece a otro proceso (misma respuesta en los tres
 * casos: no se revela cuál).
 */
@injectable()
export class GetCandidateUseCase {
    constructor(
        @inject(ProcessRepository)
        private readonly processes: ProcessRepository,
        @inject(CandidateRepository)
        private readonly candidates: CandidateRepository,
        @inject(ScoreRepository) private readonly scores: ScoreRepository,
        @inject(QuestionRepository)
        private readonly questions: QuestionRepository,
    ) {}

    execute(id: unknown): CandidateDetailDTO {
        assertValidId(id);
        const active = requireActiveProcess(this.processes);
        const row = this.candidates.findActiveInProcess(id, active.id);
        if (!row) {
            throw new AppError("NOT_FOUND");
        }
        const score = this.scores.findByCandidate(id);
        return toCandidateDetail(
            row,
            score ? toCandidateScoreDTO(score) : null,
            this.questions.listByCandidate(id).map(toQuestionDTO),
        );
    }
}
