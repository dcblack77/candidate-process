import { CreateModule, interfaces } from "@expressots/core";
import { GetRankingUseCase } from "./get-ranking.usecase";
import { RankingController } from "./ranking.controller";

/**
 * Módulo del dominio Ranking (BLUEPRINT §15). Depende de bindings de otros
 * módulos del mismo contenedor (ProcessRepository, CandidateRepository,
 * ScoreRepository, QuestionRepository, RateLimiter).
 */
export const RankingModule = CreateModule(
    [RankingController],
    (bind: interfaces.Bind) => {
        bind(GetRankingUseCase).toSelf().inSingletonScope();
    },
);
