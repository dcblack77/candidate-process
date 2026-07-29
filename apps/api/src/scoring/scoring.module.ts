import { CreateModule, interfaces } from "@expressots/core";
import { AddNoteUseCase } from "./add-note.usecase";
import { AnalyzeCandidateUseCase } from "./analyze-candidate.usecase";
import { EditScoreUseCase } from "./edit-score.usecase";
import { ScoreRepository } from "./score.repository";
import { ScoringController } from "./scoring.controller";

/**
 * Módulo del dominio Scoring (BLUEPRINT §06, §13): análisis con el modelo,
 * edición manual de puntuaciones y notas privadas. Depende de bindings de
 * otros módulos del mismo contenedor (ProcessRepository, CandidateRepository,
 * LlmClient, RateLimiter, AuditRepository).
 */
export const ScoringModule = CreateModule(
    [ScoringController],
    (bind: interfaces.Bind) => {
        bind(ScoreRepository).toSelf().inSingletonScope();
        bind(AnalyzeCandidateUseCase).toSelf().inSingletonScope();
        bind(EditScoreUseCase).toSelf().inSingletonScope();
        bind(AddNoteUseCase).toSelf().inSingletonScope();
    },
);
