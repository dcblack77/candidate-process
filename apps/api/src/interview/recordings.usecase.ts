import { inject, injectable } from "@expressots/core";
import { CandidateRepository } from "../candidates/candidate.repository";
import { AppEnv, ENV } from "../env";
import {
    ProcessRepository,
    requireCurrentProcess,
} from "../process/process.repository";
import { AuditRepository } from "../shared/audit";
import { AppError } from "../shared/errors";
import { assertValidId } from "../shared/ids";
import { RecordingDTO, toRecordingDTO } from "./interview.dto";
import { InterviewJobRegistry } from "./job-registry";
import { parseTracks, RecordingRepository } from "./recording.repository";
import { recordingBytes, removeRecording } from "./recording-store";

/**
 * Listado y borrado de las grabaciones conservadas (BLUEPRINT §24,
 * 2026-08-10).
 *
 * Ambos usan `requireCurrentProcess` y NO `requireWritableProcess`: sobre un
 * proceso archivado sigue habiendo audio de personas reales en disco, y §17
 * exige que borrarlo esté disponible en cualquier momento sobre cualquier
 * proceso. Impedir el borrado en un proceso cerrado sería justo lo contrario.
 */
@injectable()
export class ListRecordingsUseCase {
    constructor(
        @inject(ProcessRepository)
        private readonly processes: ProcessRepository,
        @inject(CandidateRepository)
        private readonly candidates: CandidateRepository,
        @inject(RecordingRepository)
        private readonly recordings: RecordingRepository,
        @inject(InterviewJobRegistry)
        private readonly jobs: InterviewJobRegistry,
        @inject(ENV) private readonly env: AppEnv,
    ) {}

    execute(candidateId: unknown): { recordings: RecordingDTO[] } {
        // El estado del último análisis se cruza con los jobs vivos: una fila
        // en `running` cuyo job ya no existe es un análisis interrumpido.
        const live = {
            liveStatus: (jobId: string) => {
                const status = this.jobs.find(jobId)?.status;
                return status === "queued" || status === "running"
                    ? status
                    : undefined;
            },
        };
        assertValidId(candidateId);
        const selected = requireCurrentProcess(this.processes);
        if (!this.candidates.findActiveInProcess(candidateId, selected.id)) {
            throw new AppError("NOT_FOUND");
        }

        const rows = this.recordings.listByCandidate(candidateId);
        return {
            recordings: rows.map((row) => {
                const tracks = parseTracks(row);
                // El tamaño se MIDE en disco en vez de confiar en la columna:
                // si alguien limpió los archivos a mano, la pantalla tiene que
                // enseñar 0 y no un tamaño que ya no existe.
                return toRecordingDTO(
                    row,
                    tracks,
                    recordingBytes(this.env.RECORDINGS_DIR, row.id, tracks),
                    live,
                );
            }),
        };
    }
}

/**
 * DELETE /candidates/:id/interview/recordings/:recordingId
 *
 * Borra los archivos ANTES que la fila. Ese orden importa: si el proceso muere
 * entre las dos operaciones, lo que queda es una fila apuntando a un
 * directorio vacío —visible y borrable desde la pantalla— y no un directorio
 * con audio de una persona real que ya nadie sabe que existe.
 */
@injectable()
export class DeleteRecordingUseCase {
    constructor(
        @inject(ProcessRepository)
        private readonly processes: ProcessRepository,
        @inject(CandidateRepository)
        private readonly candidates: CandidateRepository,
        @inject(RecordingRepository)
        private readonly recordings: RecordingRepository,
        @inject(AuditRepository) private readonly audit: AuditRepository,
        @inject(ENV) private readonly env: AppEnv,
    ) {}

    execute(
        candidateId: unknown,
        recordingId: unknown,
    ): { id: string; deleted: true } {
        assertValidId(candidateId);
        assertValidId(recordingId);

        const selected = requireCurrentProcess(this.processes);
        if (!this.candidates.findActiveInProcess(candidateId, selected.id)) {
            throw new AppError("NOT_FOUND");
        }

        const row = this.recordings.findByIdForCandidate(
            recordingId,
            candidateId,
        );
        if (!row) {
            throw new AppError("NOT_FOUND");
        }

        removeRecording(this.env.RECORDINGS_DIR, row.id);
        this.recordings.delete(row.id);

        this.audit.logEvent(
            "interview.recording_deleted",
            "candidate",
            candidateId,
            { recordingId: row.id },
        );
        return { id: row.id, deleted: true };
    }
}
