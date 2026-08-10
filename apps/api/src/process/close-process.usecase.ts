import { inject, injectable } from "@expressots/core";
import { AppEnv, ENV } from "../env";
import { RecordingRepository } from "../interview/recording.repository";
import { removeRecording } from "../interview/recording-store";
import { AuditRepository } from "../shared/audit";
import { AppError } from "../shared/errors";
import { assertValidId } from "../shared/ids";
import {
    assertConfirmDelete,
    ProcessPurgeResponseDTO,
    ProcessResponseDTO,
    toProcessResponse,
} from "./process.dto";
import { ProcessRepository, requireCurrentProcess } from "./process.repository";

/**
 * Archivado y borrado de procesos (BLUEPRINT §17, multiproceso 2026-08-07).
 *
 * Cerrar y borrar dejaron de ser la misma cosa:
 *
 * - **Cerrar** (POST /process/close) ARCHIVA el proceso seleccionado:
 *   status='closed' + closed_at, conservando candidatos, puntuaciones,
 *   preguntas y notas en SOLO LECTURA. No pide confirmación porque no
 *   destruye nada y se deshace con /reopen.
 * - **Borrar** (DELETE /process[/:id]) purga: DELETE de la fila `process`
 *   con FK CASCADE, que arrastra todos los datos derivados. Sigue exigiendo
 *   `confirmDelete: true` literal y es irreversible. La fila NO se conserva
 *   como traza: la única huella es el app_event con ids y conteos, nunca
 *   nombres ni contenido.
 *
 * Al archivar dejan de borrarse los datos de candidatos, así que la deuda
 * del cifrado en reposo (§17) pesa más que antes: ahora los datos de un
 * proceso terminado siguen en `data/local.db` hasta que se borre a mano.
 */

/** POST /process/close — archiva el proceso seleccionado sin borrar datos. */
@injectable()
export class CloseProcessUseCase {
    constructor(
        @inject(ProcessRepository)
        private readonly processes: ProcessRepository,
        @inject(AuditRepository) private readonly audit: AuditRepository,
    ) {}

    execute(): ProcessResponseDTO {
        const current = requireCurrentProcess(this.processes);
        if (current.status === "closed") {
            throw new AppError("PROCESS_CLOSED", "El proceso ya está archivado.");
        }

        const row = this.processes.close(current.id);
        this.audit.logEvent("process.closed", "process", row.id, {
            dataRetained: true,
        });
        return toProcessResponse(row);
    }
}

/** POST /process/:id/reopen — devuelve un proceso archivado a escritura. */
@injectable()
export class ReopenProcessUseCase {
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
        if (target.status === "active") {
            return toProcessResponse(target);
        }

        const row = this.processes.reopen(id);
        this.audit.logEvent("process.reopened", "process", row.id);
        return toProcessResponse(row);
    }
}

/**
 * DELETE /process (proceso seleccionado) y DELETE /process/:id (uno
 * concreto). Ambas purgan definitivamente y exigen `confirmDelete: true`.
 */
@injectable()
export class DeleteProcessUseCase {
    constructor(
        @inject(ProcessRepository)
        private readonly processes: ProcessRepository,
        @inject(RecordingRepository)
        private readonly recordings: RecordingRepository,
        @inject(AuditRepository) private readonly audit: AuditRepository,
        @inject(ENV) private readonly env: AppEnv,
    ) {}

    /** `id` ausente = purga el proceso seleccionado. */
    execute(body: unknown, id?: unknown): ProcessPurgeResponseDTO {
        assertConfirmDelete(body);

        let targetId: string;
        if (id === undefined) {
            targetId = requireCurrentProcess(this.processes).id;
        } else {
            assertValidId(id);
            if (!this.processes.findById(id)) {
                throw new AppError("NOT_FOUND", "Ese proceso no existe.");
            }
            targetId = id;
        }

        // Los archivos ANTES que las filas: el ON DELETE CASCADE se lleva las
        // filas de `interview_recording` y con ellas la única pista de qué
        // directorios había en disco. Al revés dejaría audio de personas
        // reales huérfano y sin forma de encontrarlo desde la app (§24).
        const recordings = this.recordings.listByProcess(targetId);
        for (const recording of recordings) {
            removeRecording(this.env.RECORDINGS_DIR, recording.id);
        }

        const counts = this.processes.purge(targetId);
        this.audit.logEvent("process.deleted", "process", targetId, {
            ...counts,
            recordings: recordings.length,
        });

        return { deleted: true, ...counts, recordings: recordings.length };
    }
}
