import { inject, injectable } from "@expressots/core";
import {
    ProcessListItemDTO,
    ProcessResponseDTO,
    toProcessListItem,
    toProcessResponse,
} from "./process.dto";
import { ProcessRepository, requireCurrentProcess } from "./process.repository";

/** GET /process — devuelve el proceso seleccionado o NOT_FOUND si no hay. */
@injectable()
export class GetProcessUseCase {
    constructor(
        @inject(ProcessRepository)
        private readonly processes: ProcessRepository,
    ) {}

    execute(): ProcessResponseDTO {
        return toProcessResponse(requireCurrentProcess(this.processes));
    }
}

/**
 * GET /process/list — todos los procesos, abiertos y archivados, para poder
 * cambiar de uno a otro. Devuelve lista vacía si no hay ninguno (no es un
 * error: es el estado inicial de la aplicación).
 */
@injectable()
export class ListProcessesUseCase {
    constructor(
        @inject(ProcessRepository)
        private readonly processes: ProcessRepository,
    ) {}

    execute(): ProcessListItemDTO[] {
        return this.processes.listAll().map(toProcessListItem);
    }
}
