import { CreateModule, interfaces } from "@expressots/core";
import { ExportSessionCounter } from "./export-session";
import { ExportController } from "./export.controller";
import { ExportUseCase } from "./export.usecase";

/**
 * Módulo del dominio Export (BLUEPRINT §19). El contador de exportaciones
 * por sesión es un singleton en memoria: se reinicia con la API.
 */
export const ExportModule = CreateModule(
    [ExportController],
    (bind: interfaces.Bind) => {
        bind(ExportSessionCounter).toSelf().inSingletonScope();
        bind(ExportUseCase).toSelf().inSingletonScope();
    },
);
