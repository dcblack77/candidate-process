import { CreateModule, interfaces } from "@expressots/core";
import { CompareCandidatesUseCase } from "./compare-candidates.usecase";
import { ComparisonController } from "./comparison.controller";

/**
 * Módulo del dominio Comparison (BLUEPRINT §15, §21): comparación cualitativa
 * de candidatos con el modelo local. Sin repositorio propio: no persiste
 * nada. Depende de bindings de otros módulos del mismo contenedor
 * (ProcessRepository, CandidateRepository, ScoreRepository,
 * QuestionRepository, LlmClient, RateLimiter, AuditRepository).
 */
export const ComparisonModule = CreateModule(
    [ComparisonController],
    (bind: interfaces.Bind) => {
        bind(CompareCandidatesUseCase).toSelf().inSingletonScope();
    },
);
