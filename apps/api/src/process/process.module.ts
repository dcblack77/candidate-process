import { CreateModule, interfaces } from "@expressots/core";
import {
    CloseProcessUseCase,
    DeleteProcessUseCase,
    ReopenProcessUseCase,
} from "./close-process.usecase";
import { CreateProcessUseCase } from "./create-process.usecase";
import { GetProcessUseCase, ListProcessesUseCase } from "./get-process.usecase";
import { ProcessController } from "./process.controller";
import { SelectProcessUseCase } from "./select-process.usecase";
import { UpdateProcessUseCase } from "./update-process.usecase";
import { ProcessRepository } from "./process.repository";

/**
 * Módulo del dominio Process. `ProcessRepository` se bindea aquí una única
 * vez y lo consumen también los usecases de candidates (mismo contenedor).
 */
export const ProcessModule = CreateModule(
    [ProcessController],
    (bind: interfaces.Bind) => {
        bind(ProcessRepository).toSelf().inSingletonScope();
        bind(GetProcessUseCase).toSelf().inSingletonScope();
        bind(ListProcessesUseCase).toSelf().inSingletonScope();
        bind(CreateProcessUseCase).toSelf().inSingletonScope();
        bind(UpdateProcessUseCase).toSelf().inSingletonScope();
        bind(SelectProcessUseCase).toSelf().inSingletonScope();
        bind(CloseProcessUseCase).toSelf().inSingletonScope();
        bind(ReopenProcessUseCase).toSelf().inSingletonScope();
        bind(DeleteProcessUseCase).toSelf().inSingletonScope();
    },
);
