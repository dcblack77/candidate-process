import { inject, injectable } from "@expressots/core";
import {
    ProcessRepository,
    requireActiveProcess,
} from "../process/process.repository";
import { AuditRepository } from "../shared/audit";
import { AppError } from "../shared/errors";
import { assertValidId } from "../shared/ids";
import { CandidateDeleteResponseDTO } from "./candidate.dto";
import { CandidateRepository } from "./candidate.repository";

/**
 * DELETE /candidates/:id — borrado lógico (deleted_at). El borrado físico
 * de sus datos llega con la purga del proceso (close/delete de /process).
 */
@injectable()
export class DeleteCandidateUseCase {
    constructor(
        @inject(ProcessRepository)
        private readonly processes: ProcessRepository,
        @inject(CandidateRepository)
        private readonly candidates: CandidateRepository,
        @inject(AuditRepository) private readonly audit: AuditRepository,
    ) {}

    execute(id: unknown): CandidateDeleteResponseDTO {
        assertValidId(id);
        const active = requireActiveProcess(this.processes);

        const row = this.candidates.findActiveInProcess(id, active.id);
        if (!row) {
            throw new AppError("NOT_FOUND");
        }

        this.candidates.softDelete(row.id);
        this.audit.logEvent("candidate.deleted", "candidate", row.id, {
            processId: active.id,
            softDelete: true,
        });
        return { id: row.id, deleted: true };
    }
}
