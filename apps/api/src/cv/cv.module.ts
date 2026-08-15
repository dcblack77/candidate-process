import { CreateModule, interfaces } from "@expressots/core";
import { BulkImportJobRegistry } from "./bulk-import-job";
import { BulkImportCvsUseCase } from "./bulk-import.usecase";
import { CvController } from "./cv.controller";
import { CvSummarizer } from "./cv-summarizer";
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
        bind(CvSummarizer).toSelf().inSingletonScope();
        bind(ExtractCvUseCase).toSelf().inSingletonScope();
        bind(BulkImportJobRegistry).toSelf().inSingletonScope();
        bind(BulkImportCvsUseCase).toSelf().inSingletonScope();
    },
);
