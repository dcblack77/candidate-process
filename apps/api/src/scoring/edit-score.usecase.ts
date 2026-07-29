import { inject, injectable } from "@expressots/core";
import { CRITERIA } from "../ai/schemas/common";
import { CandidateRepository } from "../candidates/candidate.repository";
import {
    ProcessRepository,
    requireActiveProcess,
} from "../process/process.repository";
import { QuestionRepository } from "../questions/question.repository";
import { interviewScoreOf } from "../questions/questions.dto";
import { AuditRepository } from "../shared/audit";
import { AppError } from "../shared/errors";
import { assertValidId } from "../shared/ids";
import { ManualScoreFields, ScoreRepository } from "./score.repository";
import {
    CandidateScoreDTO,
    parseScorePatchInput,
    toCandidateScoreDTO,
} from "./scoring.dto";
import { computeFinalScore, CriterionScores } from "./weights";

/**
 * PATCH /candidates/:id/score (BLUEPRINT §11 paso 11): edición manual.
 *
 * - Body parcial: criterios 1-5 enteros, confidence 0-1, manualNotes.
 * - El final_score se RECALCULA con weights.ts sobre los valores resultantes
 *   (existentes + parche) siempre que los cinco criterios queden definidos.
 * - DECISIÓN documentada: si el candidato aún no tiene fila de score, el
 *   parche debe traer los CINCO criterios para crearla; si no, se responde
 *   404 NOT_FOUND con mensaje claro (no hay nada parcial que editar).
 */
@injectable()
export class EditScoreUseCase {
    constructor(
        @inject(ProcessRepository)
        private readonly processes: ProcessRepository,
        @inject(CandidateRepository)
        private readonly candidates: CandidateRepository,
        @inject(ScoreRepository) private readonly scores: ScoreRepository,
        @inject(QuestionRepository)
        private readonly questions: QuestionRepository,
        @inject(AuditRepository) private readonly audit: AuditRepository,
    ) {}

    execute(id: unknown, body: unknown): CandidateScoreDTO {
        assertValidId(id);
        const input = parseScorePatchInput(body);

        const active = requireActiveProcess(this.processes);
        const candidate = this.candidates.findActiveInProcess(id, active.id);
        if (!candidate) {
            throw new AppError("NOT_FOUND");
        }

        const existing = this.scores.findByCandidate(id);

        // Valores de criterio resultantes tras aplicar el parche.
        const merged: Partial<CriterionScores> = {};
        for (const criterion of CRITERIA) {
            const value =
                input.criteria[criterion] ?? existing?.[criterion] ?? undefined;
            if (value !== undefined && value !== null) {
                merged[criterion] = value;
            }
        }
        const isComplete = CRITERIA.every(
            (criterion) => merged[criterion] !== undefined,
        );

        if (!existing && !isComplete) {
            throw new AppError(
                "NOT_FOUND",
                "El candidato aún no tiene puntuación: para crearla envía los cinco criterios.",
            );
        }

        const fields: ManualScoreFields = {
            ...input.criteria,
            confidence: input.confidence,
            manualNotes: input.manualNotes,
        };
        if (isComplete) {
            fields.finalScore = computeFinalScore(merged as CriterionScores);
        }

        const row = existing
            ? this.scores.updateManual(id, fields)
            : this.scores.createManual(id, fields);

        // Auditoría sin contenido (§17): solo qué campos cambiaron.
        this.audit.logEvent("candidate.score_edited", "candidate", id, {
            fields: Object.keys(input.criteria)
                .concat(input.confidence !== undefined ? ["confidence"] : [])
                .concat(input.manualNotes !== undefined ? ["manualNotes"] : [])
                .join(","),
        });

        // El combinado (§06) necesita la nota de entrevista, que vive en las
        // preguntas: se lee aquí para que la respuesta del PATCH ya la lleve.
        const interview = interviewScoreOf(this.questions.listByCandidate(id));
        return toCandidateScoreDTO(row, interview.overall);
    }
}
