import {
    body,
    controller,
    Delete,
    Http,
    param,
    Patch,
    Post,
    request,
} from "@expressots/adapter-express";
import { inject } from "@expressots/core";
import { Request } from "express";
import {
    canEditScores,
    canGenerateQuestions,
    requirePermission,
} from "../security/permissions";
import { AnswerQuestionUseCase } from "./answer-question.usecase";
import {
    DeleteQuestionResponseDTO,
    DeleteQuestionUseCase,
} from "./delete-question.usecase";
import { GenerateQuestionsUseCase } from "./generate-questions.usecase";
import {
    AnswerQuestionResponseDTO,
    GenerateQuestionsResponseDTO,
} from "./questions.dto";

/**
 * Rutas de preguntas de entrevista (BLUEPRINT §10):
 * POST /candidates/:id/questions,
 * PATCH /candidates/:id/questions/:questionId/answer y
 * DELETE /candidates/:id/questions/:questionId (solo sin respuesta). No hay
 * GET propio: las preguntas persistidas se devuelven dentro de
 * GET /candidates/:id.
 *
 * Permisos (§09): generar y borrar una pregunta generada usan
 * canGenerateQuestions (es curar el lote que propuso el sistema; lo que
 * tenga respuesta del evaluador no se puede borrar); puntuar una respuesta
 * usa canEditScores (es evaluación, igual que editar puntuaciones).
 */
@controller("/candidates")
export class QuestionsController {
    constructor(
        @inject(GenerateQuestionsUseCase)
        private readonly generateQuestions: GenerateQuestionsUseCase,
        @inject(AnswerQuestionUseCase)
        private readonly answerQuestion: AnswerQuestionUseCase,
        @inject(DeleteQuestionUseCase)
        private readonly deleteQuestion: DeleteQuestionUseCase,
    ) {}

    @Post("/:id/questions")
    @Http(201)
    generate(
        @request() req: Request,
        @param("id") id: string,
        @body() payload: unknown,
    ): Promise<GenerateQuestionsResponseDTO> {
        requirePermission(canGenerateQuestions, req.currentUser);
        return this.generateQuestions.execute(id, payload);
    }

    @Patch("/:id/questions/:questionId/answer")
    @Http(200)
    answer(
        @request() req: Request,
        @param("id") id: string,
        @param("questionId") questionId: string,
        @body() payload: unknown,
    ): AnswerQuestionResponseDTO {
        requirePermission(canEditScores, req.currentUser);
        return this.answerQuestion.execute(id, questionId, payload);
    }

    @Delete("/:id/questions/:questionId")
    @Http(200)
    remove(
        @request() req: Request,
        @param("id") id: string,
        @param("questionId") questionId: string,
    ): DeleteQuestionResponseDTO {
        requirePermission(canGenerateQuestions, req.currentUser);
        return this.deleteQuestion.execute(id, questionId);
    }
}
