import { inject, injectable } from "@expressots/core";
import { AuditRepository } from "../shared/audit";
import { assertConfirmDelete, ProcessPurgeResponseDTO } from "./process.dto";
import { ProcessRepository, requireActiveProcess } from "./process.repository";

/**
 * Cierre/borrado del proceso (BLUEPRINT §17, plan §Esquema SQL).
 *
 * Ambas rutas (POST /process/close y DELETE /process) exigen
 * `confirmDelete: true` literal y purgan el proceso activo: DELETE de la
 * fila `process` con FK CASCADE, que arrastra candidatos, puntuaciones y
 * preguntas. La fila process NO se conserva como traza: la única huella es
 * el app_event ('process.closed' o 'process.deleted') con ids y conteos,
 * nunca nombres ni contenido.
 */

type PurgeAction = "process.closed" | "process.deleted";

function purgeActiveProcess(
    processes: ProcessRepository,
    audit: AuditRepository,
    body: unknown,
    action: PurgeAction,
): ProcessPurgeResponseDTO {
    assertConfirmDelete(body);
    const active = requireActiveProcess(processes);

    const counts = processes.purge(active.id);
    audit.logEvent(action, "process", active.id, { ...counts });

    return { deleted: true, ...counts };
}

/** POST /process/close — cierra el proceso borrando todos sus datos. */
@injectable()
export class CloseProcessUseCase {
    constructor(
        @inject(ProcessRepository)
        private readonly processes: ProcessRepository,
        @inject(AuditRepository) private readonly audit: AuditRepository,
    ) {}

    execute(body: unknown): ProcessPurgeResponseDTO {
        return purgeActiveProcess(
            this.processes,
            this.audit,
            body,
            "process.closed",
        );
    }
}

/** DELETE /process — borra el proceso activo con la misma confirmación. */
@injectable()
export class DeleteProcessUseCase {
    constructor(
        @inject(ProcessRepository)
        private readonly processes: ProcessRepository,
        @inject(AuditRepository) private readonly audit: AuditRepository,
    ) {}

    execute(body: unknown): ProcessPurgeResponseDTO {
        return purgeActiveProcess(
            this.processes,
            this.audit,
            body,
            "process.deleted",
        );
    }
}
