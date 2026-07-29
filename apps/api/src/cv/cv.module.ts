import { CreateModule, interfaces } from "@expressots/core";
import { CvController } from "./cv.controller";
import { ExtractCvUseCase } from "./extract-cv.usecase";

/**
 * Módulo del dominio CV (BLUEPRINT §05, §20): extracción de texto + resumen.
 * Depende de bindings de otros módulos del mismo contenedor:
 * ProcessRepository y CandidateRepository (dominios), LlmClient/PromptLoader
 * (AiModule) y RateLimiter/AuditRepository/ENV (CoreModule).
 */
export const CvModule = CreateModule(
    [CvController],
    (bind: interfaces.Bind) => {
        bind(ExtractCvUseCase).toSelf().inSingletonScope();
    },
);
