import { inject, injectable } from "@expressots/core";
import { CandidateRepository } from "../candidates/candidate.repository";
import {
    ProcessRepository,
    requireCurrentProcess,
} from "../process/process.repository";
import { AuditRepository } from "../shared/audit";
import { AppError } from "../shared/errors";
import { assertValidId } from "../shared/ids";
import { MAX_RISK_DETECTIONS_PER_CANDIDATE } from "../shared/limits";
import { RISKS_DETECTED_ACTION } from "./detect-risks.usecase";
import { RiskRepository } from "./risk.repository";
import { GetRisksResponseDTO, toRiskAnalysisDTO } from "./risks.dto";

/**
 * GET /candidates/:id/risks: la última detección persistida del candidato,
 * o `analysis: null` si aún no hay. Es LECTURA: funciona también sobre un
 * proceso archivado (`requireCurrentProcess`, no `requireWritableProcess`).
 */
@injectable()
export class GetRisksUseCase {
    constructor(
        @inject(ProcessRepository)
        private readonly processes: ProcessRepository,
        @inject(CandidateRepository)
        private readonly candidates: CandidateRepository,
        @inject(RiskRepository) private readonly risks: RiskRepository,
        @inject(AuditRepository) private readonly audit: AuditRepository,
    ) {}

    execute(id: unknown): GetRisksResponseDTO {
        assertValidId(id);
        const selected = requireCurrentProcess(this.processes);
        const candidate = this.candidates.findActiveInProcess(id, selected.id);
        if (!candidate) {
            throw new AppError("NOT_FOUND");
        }

        const row = this.risks.findByCandidate(id);
        return {
            candidateId: id,
            analysis: row ? toRiskAnalysisDTO(row) : null,
            regenerationsUsed: this.audit.countByActionAndEntity(
                RISKS_DETECTED_ACTION,
                id,
            ),
            regenerationsLimit: MAX_RISK_DETECTIONS_PER_CANDIDATE,
        };
    }
}
