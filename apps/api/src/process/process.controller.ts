import {
    body,
    controller,
    Delete,
    Get,
    Http,
    Patch,
    Post,
    request,
} from "@expressots/adapter-express";
import { inject } from "@expressots/core";
import { Request } from "express";
import {
    canCloseProcess,
    canCreateProcess,
    canDeleteData,
    requirePermission,
} from "../security/permissions";
import {
    CloseProcessUseCase,
    DeleteProcessUseCase,
} from "./close-process.usecase";
import { CreateProcessUseCase } from "./create-process.usecase";
import { GetProcessUseCase } from "./get-process.usecase";
import { ProcessPurgeResponseDTO, ProcessResponseDTO } from "./process.dto";
import { UpdateProcessUseCase } from "./update-process.usecase";

/**
 * Rutas del proceso de selección (BLUEPRINT §10).
 *
 * Toda ruta valida permisos en backend (requirePermission + canXxx de §09)
 * antes de delegar en su usecase. La lectura y edición del proceso usan
 * canCreateProcess (gestión del proceso); el cierre usa canCloseProcess y
 * el borrado canDeleteData.
 */
@controller("/process")
export class ProcessController {
    constructor(
        @inject(GetProcessUseCase)
        private readonly getProcess: GetProcessUseCase,
        @inject(CreateProcessUseCase)
        private readonly createProcess: CreateProcessUseCase,
        @inject(UpdateProcessUseCase)
        private readonly updateProcess: UpdateProcessUseCase,
        @inject(CloseProcessUseCase)
        private readonly closeProcess: CloseProcessUseCase,
        @inject(DeleteProcessUseCase)
        private readonly deleteProcess: DeleteProcessUseCase,
    ) {}

    @Get("/")
    get(@request() req: Request): ProcessResponseDTO {
        requirePermission(canCreateProcess, req.currentUser);
        return this.getProcess.execute();
    }

    @Post("/")
    @Http(201)
    create(
        @request() req: Request,
        @body() payload: unknown,
    ): ProcessResponseDTO {
        requirePermission(canCreateProcess, req.currentUser);
        return this.createProcess.execute(payload);
    }

    @Patch("/")
    @Http(200)
    update(
        @request() req: Request,
        @body() payload: unknown,
    ): ProcessResponseDTO {
        requirePermission(canCreateProcess, req.currentUser);
        return this.updateProcess.execute(payload);
    }

    @Post("/close")
    @Http(200)
    close(
        @request() req: Request,
        @body() payload: unknown,
    ): ProcessPurgeResponseDTO {
        requirePermission(canCloseProcess, req.currentUser);
        return this.closeProcess.execute(payload);
    }

    @Delete("/")
    @Http(200)
    remove(
        @request() req: Request,
        @body() payload: unknown,
    ): ProcessPurgeResponseDTO {
        requirePermission(canDeleteData, req.currentUser);
        return this.deleteProcess.execute(payload);
    }
}
