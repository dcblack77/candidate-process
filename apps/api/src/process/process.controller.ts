import {
    body,
    controller,
    Delete,
    Get,
    Http,
    param,
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
    ReopenProcessUseCase,
} from "./close-process.usecase";
import { CreateProcessUseCase } from "./create-process.usecase";
import { GetProcessUseCase, ListProcessesUseCase } from "./get-process.usecase";
import {
    ProcessListItemDTO,
    ProcessPurgeResponseDTO,
    ProcessResponseDTO,
} from "./process.dto";
import { SelectProcessUseCase } from "./select-process.usecase";
import { UpdateProcessUseCase } from "./update-process.usecase";

/**
 * Rutas del proceso de selección (BLUEPRINT §10).
 *
 * Toda ruta valida permisos en backend (requirePermission + canXxx de §09)
 * antes de delegar en su usecase. La lectura, creación, edición y selección
 * usan canCreateProcess (gestión del proceso); archivar y reabrir usan
 * canCloseProcess y el borrado definitivo canDeleteData.
 *
 * Las rutas literales (/list, /close) se declaran antes que las paramétricas
 * (/:id/select, /:id/reopen) para que el enrutador no intente interpretar
 * "list" o "close" como un id.
 */
@controller("/process")
export class ProcessController {
    constructor(
        @inject(GetProcessUseCase)
        private readonly getProcess: GetProcessUseCase,
        @inject(ListProcessesUseCase)
        private readonly listProcesses: ListProcessesUseCase,
        @inject(CreateProcessUseCase)
        private readonly createProcess: CreateProcessUseCase,
        @inject(UpdateProcessUseCase)
        private readonly updateProcess: UpdateProcessUseCase,
        @inject(SelectProcessUseCase)
        private readonly selectProcess: SelectProcessUseCase,
        @inject(CloseProcessUseCase)
        private readonly closeProcess: CloseProcessUseCase,
        @inject(ReopenProcessUseCase)
        private readonly reopenProcess: ReopenProcessUseCase,
        @inject(DeleteProcessUseCase)
        private readonly deleteProcess: DeleteProcessUseCase,
    ) {}

    /** Proceso seleccionado; 404 si todavía no hay ninguno. */
    @Get("/")
    get(@request() req: Request): ProcessResponseDTO {
        requirePermission(canCreateProcess, req.currentUser);
        return this.getProcess.execute();
    }

    /** Todos los procesos (abiertos y archivados) para poder cambiar. */
    @Get("/list")
    list(@request() req: Request): ProcessListItemDTO[] {
        requirePermission(canCreateProcess, req.currentUser);
        return this.listProcesses.execute();
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

    /** Archiva el proceso seleccionado conservando sus datos. */
    @Post("/close")
    @Http(200)
    close(@request() req: Request): ProcessResponseDTO {
        requirePermission(canCloseProcess, req.currentUser);
        return this.closeProcess.execute();
    }

    /** Cambia cuál es el proceso seleccionado (afecta a todos los clientes). */
    @Post("/:id/select")
    @Http(200)
    select(
        @request() req: Request,
        @param("id") id: string,
    ): ProcessResponseDTO {
        requirePermission(canCreateProcess, req.currentUser);
        return this.selectProcess.execute(id);
    }

    /** Devuelve un proceso archivado a estado abierto. */
    @Post("/:id/reopen")
    @Http(200)
    reopen(
        @request() req: Request,
        @param("id") id: string,
    ): ProcessResponseDTO {
        requirePermission(canCloseProcess, req.currentUser);
        return this.reopenProcess.execute(id);
    }

    /** Borra definitivamente el proceso seleccionado (confirmDelete: true). */
    @Delete("/")
    @Http(200)
    remove(
        @request() req: Request,
        @body() payload: unknown,
    ): ProcessPurgeResponseDTO {
        requirePermission(canDeleteData, req.currentUser);
        return this.deleteProcess.execute(payload);
    }

    /** Borra definitivamente un proceso concreto (confirmDelete: true). */
    @Delete("/:id")
    @Http(200)
    removeById(
        @request() req: Request,
        @param("id") id: string,
        @body() payload: unknown,
    ): ProcessPurgeResponseDTO {
        requirePermission(canDeleteData, req.currentUser);
        return this.deleteProcess.execute(payload, id);
    }
}
