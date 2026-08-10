import { inject, injectable } from "@expressots/core";
import {
    ProcessRepository,
    requireCurrentProcess,
} from "../process/process.repository";
import { CandidateListItemDTO, toCandidateListItem } from "./candidate.dto";
import { CandidateRepository } from "./candidate.repository";

/**
 * GET /candidates — candidatos no borrados del proceso seleccionado.
 * Sin proceso seleccionado no hay colección que listar: NOT_FOUND.
 */
@injectable()
export class ListCandidatesUseCase {
    constructor(
        @inject(ProcessRepository)
        private readonly processes: ProcessRepository,
        @inject(CandidateRepository)
        private readonly candidates: CandidateRepository,
    ) {}

    execute(): CandidateListItemDTO[] {
        const selected = requireCurrentProcess(this.processes);
        return this.candidates.listActive(selected.id).map(toCandidateListItem);
    }
}
