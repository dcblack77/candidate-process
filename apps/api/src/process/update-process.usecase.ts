import { inject, injectable } from "@expressots/core";
import { AuditRepository } from "../shared/audit";
import {
    parseUpdateProcessInput,
    ProcessResponseDTO,
    toProcessResponse,
} from "./process.dto";
import { ProcessRepository, requireActiveProcess } from "./process.repository";

/** PATCH /process — edita roleTitle/roleContext del proceso activo. */
@injectable()
export class UpdateProcessUseCase {
    constructor(
        @inject(ProcessRepository) private readonly processes: ProcessRepository,
        @inject(AuditRepository) private readonly audit: AuditRepository,
    ) {}

    execute(body: unknown): ProcessResponseDTO {
        const active = requireActiveProcess(this.processes);
        const update = parseUpdateProcessInput(body);

        const row = this.processes.update(active.id, update);
        // Auditoría sin datos sensibles: solo qué campos cambiaron.
        this.audit.logEvent("process.updated", "process", active.id, {
            roleTitleChanged: update.roleTitle !== undefined,
            roleContextChanged: update.roleContext !== undefined,
        });
        return toProcessResponse(row);
    }
}
