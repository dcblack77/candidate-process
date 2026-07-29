import { CreateModule, interfaces } from "@expressots/core";
import { HealthController } from "./health.controller";
import { HealthUseCase } from "./health.usecase";

/**
 * Módulo de health. Patrón de referencia para fases posteriores:
 * controllers en el array, usecases/repos en el callback de bindings.
 */
export const HealthModule = CreateModule(
    [HealthController],
    (bind: interfaces.Bind) => {
        bind(HealthUseCase).toSelf().inSingletonScope();
    },
);
