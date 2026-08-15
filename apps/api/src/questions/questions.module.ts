import { CreateModule, interfaces } from "@expressots/core";
import { AnswerQuestionUseCase } from "./answer-question.usecase";
import { DeleteQuestionUseCase } from "./delete-question.usecase";
import { GenerateQuestionsUseCase } from "./generate-questions.usecase";
import { QuestionRepository } from "./question.repository";
import { QuestionsController } from "./questions.controller";

/**
 * Módulo del dominio Questions (BLUEPRINT §07, §14): generación de preguntas
 * de entrevista personalizadas. Depende de bindings de otros módulos del
 * mismo contenedor (ProcessRepository, CandidateRepository, ScoreRepository,
 * LlmClient, RateLimiter, AuditRepository).
 */
export const QuestionsModule = CreateModule(
    [QuestionsController],
    (bind: interfaces.Bind) => {
        bind(QuestionRepository).toSelf().inSingletonScope();
        bind(GenerateQuestionsUseCase).toSelf().inSingletonScope();
        bind(AnswerQuestionUseCase).toSelf().inSingletonScope();
        bind(DeleteQuestionUseCase).toSelf().inSingletonScope();
    },
);
