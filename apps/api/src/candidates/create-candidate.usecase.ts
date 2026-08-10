import { inject, injectable } from "@expressots/core";
import {
    ProcessRepository,
    requireWritableProcess,
} from "../process/process.repository";
import { AuditRepository } from "../shared/audit";
import { AppError } from "../shared/errors";
import { MAX_CANDIDATES_PER_PROCESS } from "../shared/limits";
import {
    CandidateListItemDTO,
    parseCandidateNameInput,
    toCandidateListItem,
} from "./candidate.dto";
import { CandidateRepository } from "./candidate.repository";

/**
 * POST /candidates — alta de candidato en el proceso seleccionado.
 *
 * Límite §16: como mucho MAX_CANDIDATES_PER_PROCESS (100) candidatos no
 * borrados por proceso; superarlo es LIMIT_EXCEEDED.
 */
@injectable()
export class CreateCandidateUseCase {
    constructor(
        @inject(ProcessRepository)
        private readonly processes: ProcessRepository,
        @inject(CandidateRepository)
        private readonly candidates: CandidateRepository,
        @inject(AuditRepository) private readonly audit: AuditRepository,
    ) {}

    execute(body: unknown): CandidateListItemDTO {
        const { name } = parseCandidateNameInput(body);
        const selected = requireWritableProcess(this.processes);

        const current = this.candidates.countActive(selected.id);
        if (current >= MAX_CANDIDATES_PER_PROCESS) {
            throw new AppError("LIMIT_EXCEEDED");
        }

        const row = this.candidates.create(selected.id, name);
        // Auditoría sin datos sensibles: ids y contador, nunca el nombre.
        this.audit.logEvent("candidate.created", "candidate", row.id, {
            processId: selected.id,
            candidateCount: current + 1,
        });
        return toCandidateListItem(row);
    }
}
