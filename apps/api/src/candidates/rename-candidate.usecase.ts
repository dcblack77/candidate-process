import { inject, injectable } from "@expressots/core";
import {
    ProcessRepository,
    requireActiveProcess,
} from "../process/process.repository";
import { AuditRepository } from "../shared/audit";
import { AppError } from "../shared/errors";
import { assertValidId } from "../shared/ids";
import {
    CandidateListItemDTO,
    parseCandidateNameInput,
    toCandidateListItem,
} from "./candidate.dto";
import { CandidateRepository } from "./candidate.repository";

/** PATCH /candidates/:id — renombra al candidato (refresca updated_at). */
@injectable()
export class RenameCandidateUseCase {
    constructor(
        @inject(ProcessRepository)
        private readonly processes: ProcessRepository,
        @inject(CandidateRepository)
        private readonly candidates: CandidateRepository,
        @inject(AuditRepository) private readonly audit: AuditRepository,
    ) {}

    execute(id: unknown, body: unknown): CandidateListItemDTO {
        assertValidId(id);
        const { name } = parseCandidateNameInput(body);
        const active = requireActiveProcess(this.processes);

        const row = this.candidates.findActiveInProcess(id, active.id);
        if (!row) {
            throw new AppError("NOT_FOUND");
        }

        const updated = this.candidates.rename(row.id, name);
        // Auditoría sin datos sensibles: nunca el nombre anterior ni el nuevo.
        this.audit.logEvent("candidate.renamed", "candidate", row.id, {
            processId: active.id,
        });
        return toCandidateListItem(updated);
    }
}
