import { inject, injectable } from "@expressots/core";
import { CandidateRepository } from "../candidates/candidate.repository";
import {
    ProcessRepository,
    requireWritableProcess,
} from "../process/process.repository";
import { AuditRepository } from "../shared/audit";
import { AppError } from "../shared/errors";
import { assertValidId } from "../shared/ids";
import { MAX_QUESTIONS_PER_CANDIDATE } from "../shared/limits";
import { QuestionRepository } from "./question.repository";

/** Respuesta de DELETE /candidates/:id/questions/:questionId. */
export interface DeleteQuestionResponseDTO {
    id: string;
    deleted: true;
    questionsTotal: number;
    questionsLimit: number;
}

/**
 * DELETE /candidates/:id/questions/:questionId (2026-08-15).
 *
 * Existe porque el tope de 20 preguntas por candidato (§16) era un muro sin
 * puerta: no había forma de retirar una pregunta generada, así que un lote
 * flojo —un contexto de rol mal escrito, un CV en otro idioma— agotaba el
 * cupo para siempre. El tope se queda (acota el modelo y la entrevista); lo
 * que se abre es poder hacer sitio.
 *
 * Solo se borran preguntas SIN respuesta registrada: una con nota o notas es
 * evidencia de la entrevista y pesa en el score final; quitarla sería
 * reescribir la evaluación. Para eso hay que vaciar antes la respuesta por
 * el PATCH de siempre, a conciencia. Las propuestas del análisis de audio
 * que colgaran de la pregunta se van con ella (CASCADE): son salida del
 * sistema, no decisiones del evaluador.
 */
@injectable()
export class DeleteQuestionUseCase {
    constructor(
        @inject(ProcessRepository)
        private readonly processes: ProcessRepository,
        @inject(CandidateRepository)
        private readonly candidates: CandidateRepository,
        @inject(QuestionRepository)
        private readonly questions: QuestionRepository,
        @inject(AuditRepository) private readonly audit: AuditRepository,
    ) {}

    execute(candidateId: unknown, questionId: unknown): DeleteQuestionResponseDTO {
        assertValidId(candidateId);
        assertValidId(questionId);

        const selected = requireWritableProcess(this.processes);
        if (!this.candidates.findActiveInProcess(candidateId, selected.id)) {
            throw new AppError("NOT_FOUND");
        }
        const question = this.questions.findByIdForCandidate(
            questionId,
            candidateId,
        );
        if (!question) {
            throw new AppError("NOT_FOUND");
        }
        if (question.answer_score !== null || question.answer_notes !== null) {
            throw new AppError(
                "INVALID_INPUT",
                "Esta pregunta ya tiene respuesta registrada. Vacía la nota y las notas antes de borrarla.",
            );
        }

        this.questions.delete(question.id);
        const total = this.questions.countByCandidate(candidateId);

        // Auditoría SIN contenido (§17): ids y cuántas quedan.
        this.audit.logEvent("candidate.question_deleted", "candidate", candidateId, {
            questionId: question.id,
            criterion: question.criterion,
            remaining: total,
        });

        return {
            id: question.id,
            deleted: true,
            questionsTotal: total,
            questionsLimit: MAX_QUESTIONS_PER_CANDIDATE,
        };
    }
}
