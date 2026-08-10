import { inject, injectable } from "@expressots/core";
import { CandidateRepository } from "../candidates/candidate.repository";
import {
    ProcessRepository,
    requireWritableProcess,
} from "../process/process.repository";
import { AuditRepository } from "../shared/audit";
import { AppError } from "../shared/errors";
import { assertValidId } from "../shared/ids";
import { QuestionRepository } from "./question.repository";
import {
    AnswerQuestionResponseDTO,
    interviewScoreOf,
    parseAnswerInput,
    toQuestionDTO,
} from "./questions.dto";

/**
 * PATCH /candidates/:id/questions/:questionId/answer (BLUEPRINT §07 y §15):
 * registra la nota (1-10) y las notas privadas de la respuesta del candidato
 * a una pregunta concreta.
 *
 * - Permiso canEditScores: es evaluación, igual que editar puntuaciones.
 * - 404 si no hay proceso seleccionado, si el candidato no existe/está borrado o
 *   si la pregunta no existe O NO PERTENECE a ese candidato (mismo 404 en
 *   los tres casos: no se revela cuál).
 * - Fusión con lo existente: un campo ausente se deja como estaba,
 *   `score: null` borra la nota y `notes: ""` vacía el texto (se persiste
 *   NULL para que el DTO sea uniforme).
 * - answered_at se refresca en UTC en cada escritura y vuelve a NULL si la
 *   pregunta queda sin nota y sin texto.
 * - Auditoría SIN contenido (§17): solo ids, si hay nota y la longitud del
 *   texto; jamás el texto de la respuesta.
 */
@injectable()
export class AnswerQuestionUseCase {
    constructor(
        @inject(ProcessRepository)
        private readonly processes: ProcessRepository,
        @inject(CandidateRepository)
        private readonly candidates: CandidateRepository,
        @inject(QuestionRepository)
        private readonly questions: QuestionRepository,
        @inject(AuditRepository) private readonly audit: AuditRepository,
    ) {}

    execute(
        candidateId: unknown,
        questionId: unknown,
        body: unknown,
    ): AnswerQuestionResponseDTO {
        assertValidId(candidateId);
        assertValidId(questionId);
        const input = parseAnswerInput(body);

        const selected = requireWritableProcess(this.processes);
        const candidate = this.candidates.findActiveInProcess(
            candidateId,
            selected.id,
        );
        if (!candidate) {
            throw new AppError("NOT_FOUND");
        }

        const existing = this.questions.findByIdForCandidate(
            questionId,
            candidateId,
        );
        if (!existing) {
            throw new AppError("NOT_FOUND");
        }

        // Fusión con lo ya guardado: solo los campos enviados cambian.
        const answerScore =
            input.score !== undefined ? input.score : existing.answer_score;
        let answerNotes = existing.answer_notes;
        if (input.notes !== undefined) {
            // "" vacía la nota: se persiste NULL, no una cadena vacía.
            answerNotes = input.notes.length > 0 ? input.notes : null;
        }

        const row = this.questions.setAnswer(
            questionId,
            answerScore,
            answerNotes,
        );

        this.audit.logEvent(
            "question.answered",
            "interview_question",
            questionId,
            {
                candidateId,
                hasScore: row.answer_score !== null,
                notesLength: row.answer_notes?.length ?? 0,
            },
        );

        return {
            candidateId,
            question: toQuestionDTO(row),
            interview: interviewScoreOf(
                this.questions.listByCandidate(candidateId),
            ),
        };
    }
}
