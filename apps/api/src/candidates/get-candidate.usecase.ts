import { inject, injectable } from "@expressots/core";
import { ProcessRepository, requireActiveProcess } from "../process/process.repository";
import { AppError } from "../shared/errors";
import { assertValidId } from "../shared/ids";
import { CandidateDetailDTO, toCandidateDetail } from "./candidate.dto";
import { CandidateRepository } from "./candidate.repository";

/**
 * GET /candidates/:id — detalle completo del candidato, con cv_summary y
 * cv_evidence parseados a JSON. NOT_FOUND si no existe, está soft-deleted
 * o pertenece a otro proceso (misma respuesta en los tres casos: no se
 * revela cuál).
 */
@injectable()
export class GetCandidateUseCase {
    constructor(
        @inject(ProcessRepository) private readonly processes: ProcessRepository,
        @inject(CandidateRepository) private readonly candidates: CandidateRepository,
    ) {}

    execute(id: unknown): CandidateDetailDTO {
        assertValidId(id);
        const active = requireActiveProcess(this.processes);
        const row = this.candidates.findActiveInProcess(id, active.id);
        if (!row) {
            throw new AppError("NOT_FOUND");
        }
        return toCandidateDetail(row);
    }
}
