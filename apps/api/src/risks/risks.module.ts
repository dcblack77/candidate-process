import { CreateModule, interfaces } from "@expressots/core";
import { DetectRisksUseCase } from "./detect-risks.usecase";
import { GetRisksUseCase } from "./get-risks.usecase";
import { RiskRepository } from "./risk.repository";
import { RisksController } from "./risks.controller";

/**
 * Módulo del dominio Risks (BLUEPRINT §13 "Riesgos y lagunas"): detección
 * con el modelo de lo que el CV no permite saber y de los riesgos de
 * contratar, como material para la entrevista. Depende de bindings de otros
 * módulos del mismo contenedor (ProcessRepository, CandidateRepository,
 * LlmClient, RateLimiter, AuditRepository).
 *
 * Se registra en app.ts junto al resto de módulos de dominio.
 */
export const RisksModule = CreateModule(
    [RisksController],
    (bind: interfaces.Bind) => {
        bind(RiskRepository).toSelf().inSingletonScope();
        bind(DetectRisksUseCase).toSelf().inSingletonScope();
        bind(GetRisksUseCase).toSelf().inSingletonScope();
    },
);
