import { inject, injectable } from "@expressots/core";
import { AuditRepository } from "../shared/audit";
import { AppError } from "../shared/errors";
import { assertValidId } from "../shared/ids";
import { ProcessResponseDTO, toProcessResponse } from "./process.dto";
import { ProcessRepository } from "./process.repository";

/**
 * POST /process/:id/select — cambia el proceso seleccionado.
 *
 * OJO: la selección es estado de SERVIDOR compartido por todos los clientes
 * (decisión del usuario del 2026-08-07). Un cambio desde un equipo de la LAN
 * afecta a cualquier otro navegador que esté usando la aplicación.
 *
 * Se puede seleccionar un proceso archivado: queda en solo lectura y las
 * escrituras se rechazan con PROCESS_CLOSED.
 */
@injectable()
export class SelectProcessUseCase {
    constructor(
        @inject(ProcessRepository)
        private readonly processes: ProcessRepository,
        @inject(AuditRepository) private readonly audit: AuditRepository,
    ) {}

    execute(id: unknown): ProcessResponseDTO {
        assertValidId(id);
        const target = this.processes.findById(id);
        if (!target) {
            throw new AppError("NOT_FOUND", "Ese proceso no existe.");
        }

        // Idempotente: seleccionar el que ya está seleccionado no audita nada.
        if (target.is_current === 1) {
            return toProcessResponse(target);
        }

        const previous = this.processes.findCurrent();
        const row = this.processes.select(id);
        this.audit.logEvent("process.selected", "process", row.id, {
            previousProcessId: previous?.id ?? null,
        });
        return toProcessResponse(row);
    }
}
