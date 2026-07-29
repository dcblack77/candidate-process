import {
    body,
    controller,
    Http,
    param,
    Post,
    request,
} from "@expressots/adapter-express";
import { inject } from "@expressots/core";
import { Request } from "express";
import {
    canGenerateQuestions,
    requirePermission,
} from "../security/permissions";
import { GenerateQuestionsUseCase } from "./generate-questions.usecase";
import { GenerateQuestionsResponseDTO } from "./questions.dto";

/**
 * Rutas de preguntas de entrevista (BLUEPRINT §10):
 * POST /candidates/:id/questions. No hay GET propio: las preguntas
 * persistidas se devuelven dentro de GET /candidates/:id.
 */
@controller("/candidates")
export class QuestionsController {
    constructor(
        @inject(GenerateQuestionsUseCase)
        private readonly generateQuestions: GenerateQuestionsUseCase,
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
}
