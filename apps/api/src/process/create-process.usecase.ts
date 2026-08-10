import { inject, injectable } from "@expressots/core";
import { AuditRepository } from "../shared/audit";
import {
    parseCreateProcessInput,
    ProcessResponseDTO,
    toProcessResponse,
} from "./process.dto";
import { ProcessRepository } from "./process.repository";

/**
 * POST /process — crea un proceso de selección y lo deja seleccionado.
 *
 * Desde el multiproceso (2026-08-07) ya no falla si hay otros procesos
 * abiertos: crear uno nuevo NO cierra ni borra los anteriores, solo cambia
 * cuál está seleccionado. Para volver a otro: POST /process/:id/select.
 */
@injectable()
export class CreateProcessUseCase {
    constructor(
        @inject(ProcessRepository)
        private readonly processes: ProcessRepository,
        @inject(AuditRepository) private readonly audit: AuditRepository,
    ) {}

    execute(body: unknown): ProcessResponseDTO {
        const input = parseCreateProcessInput(body);

        const previous = this.processes.findCurrent();
        const row = this.processes.create(input.roleTitle, input.roleContext);

        // Auditoría sin datos sensibles: ids y cuántos procesos quedan vivos.
        this.audit.logEvent("process.created", "process", row.id, {
            previousProcessId: previous?.id ?? null,
            totalProcesses: this.processes.listAll().length,
        });
        return toProcessResponse(row);
    }
}
