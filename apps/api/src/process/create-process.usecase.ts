import { inject, injectable } from "@expressots/core";
import { AuditRepository } from "../shared/audit";
import { AppError } from "../shared/errors";
import {
    parseCreateProcessInput,
    ProcessResponseDTO,
    toProcessResponse,
} from "./process.dto";
import { ProcessRepository } from "./process.repository";

/**
 * POST /process — crea el proceso de selección.
 *
 * Solo puede haber un proceso activo (BLUEPRINT §16): se comprueba aquí y,
 * ante una carrera, el índice único parcial de la DB lo fuerza igualmente
 * (el repositorio traduce la violación a ACTIVE_PROCESS_EXISTS).
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

        if (this.processes.findActive()) {
            throw new AppError("ACTIVE_PROCESS_EXISTS");
        }

        const row = this.processes.create(input.roleTitle, input.roleContext);
        // Auditoría sin datos sensibles: solo el id del proceso.
        this.audit.logEvent("process.created", "process", row.id);
        return toProcessResponse(row);
    }
}
