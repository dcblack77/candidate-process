import { inject, injectable } from "@expressots/core";
import { CandidateRepository } from "../candidates/candidate.repository";
import {
    ProcessRepository,
    requireCurrentProcess,
    requireWritableProcess,
} from "../process/process.repository";
import { AuditRepository } from "../shared/audit";
import { AppError } from "../shared/errors";
import { assertValidId } from "../shared/ids";
import {
    parseProposalResolution,
    ProposalDTO,
    toProposalDTO,
} from "./interview.dto";
import {
    InterviewJob,
    InterviewJobRegistry,
    JobError,
    JobPhase,
    JobStats,
    JobStatus,
} from "./job-registry";
import { ProposalRepository } from "./proposal.repository";

/** Respuesta de las rutas de análisis (§24). Sin el AbortController. */
export interface InterviewAnalysisDTO {
    candidateId: string;
    jobId: string;
    status: JobStatus;
    phase: JobPhase;
    progress: { done: number; total: number };
    startedAt: string;
    finishedAt: string | null;
    stats: JobStats | null;
    error: JobError | null;
    proposals: ProposalDTO[];
}

export function toAnalysisDTO(job: InterviewJob): InterviewAnalysisDTO {
    return {
        candidateId: job.candidateId,
        jobId: job.id,
        status: job.status,
        phase: job.phase,
        progress: job.progress,
        startedAt: job.startedAt,
        finishedAt: job.finishedAt,
        stats: job.stats,
        error: job.error,
        proposals: job.proposals,
    };
}

/**
 * Localiza el job y comprueba que es de ESTE candidato. Un jobId válido de
 * otro candidato responde 404 igual que uno inexistente: no se revela cuál de
 * las dos cosas pasa.
 */
function requireJob(
    jobs: InterviewJobRegistry,
    jobId: unknown,
    candidateId: string,
): InterviewJob {
    assertValidId(jobId);
    const job = jobs.find(jobId);
    if (!job || job.candidateId !== candidateId) {
        throw new AppError("NOT_FOUND");
    }
    return job;
}

/** GET /candidates/:id/interview/analysis/:jobId — estado y progreso. */
@injectable()
export class GetAnalysisUseCase {
    constructor(
        @inject(ProcessRepository)
        private readonly processes: ProcessRepository,
        @inject(CandidateRepository)
        private readonly candidates: CandidateRepository,
        @inject(InterviewJobRegistry)
        private readonly jobs: InterviewJobRegistry,
    ) {}

    execute(candidateId: unknown, jobId: unknown): InterviewAnalysisDTO {
        assertValidId(candidateId);
        // Consultar el progreso es lectura: funciona también sobre un proceso
        // archivado, igual que ver el candidato.
        const selected = requireCurrentProcess(this.processes);
        if (!this.candidates.findActiveInProcess(candidateId, selected.id)) {
            throw new AppError("NOT_FOUND");
        }
        return toAnalysisDTO(requireJob(this.jobs, jobId, candidateId));
    }
}

/** DELETE /candidates/:id/interview/analysis/:jobId — cancela el análisis. */
@injectable()
export class CancelAnalysisUseCase {
    constructor(
        @inject(ProcessRepository)
        private readonly processes: ProcessRepository,
        @inject(CandidateRepository)
        private readonly candidates: CandidateRepository,
        @inject(InterviewJobRegistry)
        private readonly jobs: InterviewJobRegistry,
        @inject(AuditRepository) private readonly audit: AuditRepository,
    ) {}

    execute(candidateId: unknown, jobId: unknown): InterviewAnalysisDTO {
        assertValidId(candidateId);
        const selected = requireWritableProcess(this.processes);
        if (!this.candidates.findActiveInProcess(candidateId, selected.id)) {
            throw new AppError("NOT_FOUND");
        }

        const job = requireJob(this.jobs, jobId, candidateId);
        const wasRunning = job.status === "running";
        this.jobs.cancel(job.id);
        if (wasRunning) {
            this.audit.logEvent(
                "interview.cancelled",
                "candidate",
                candidateId,
                { jobId: job.id },
            );
        }
        return toAnalysisDTO(job);
    }
}

/**
 * PATCH /candidates/:id/interview/proposals/:proposalId — aplicar o descartar.
 *
 * OJO: esto NO escribe la nota. Aplicar una propuesta es, en la UI, mandar el
 * PATCH de siempre sobre la pregunta y DESPUÉS marcarla aquí. La puntuación
 * real solo la escribe el evaluador por su camino de siempre.
 */
@injectable()
export class UpdateProposalUseCase {
    constructor(
        @inject(ProcessRepository)
        private readonly processes: ProcessRepository,
        @inject(CandidateRepository)
        private readonly candidates: CandidateRepository,
        @inject(ProposalRepository)
        private readonly proposals: ProposalRepository,
        @inject(AuditRepository) private readonly audit: AuditRepository,
    ) {}

    execute(
        candidateId: unknown,
        proposalId: unknown,
        body: unknown,
    ): { proposal: ProposalDTO } {
        assertValidId(candidateId);
        assertValidId(proposalId);
        const { status } = parseProposalResolution(body);

        const selected = requireWritableProcess(this.processes);
        if (!this.candidates.findActiveInProcess(candidateId, selected.id)) {
            throw new AppError("NOT_FOUND");
        }

        const existing = this.proposals.findByIdForCandidate(
            proposalId,
            candidateId,
        );
        if (!existing) {
            throw new AppError("NOT_FOUND");
        }

        const row = this.proposals.resolve(proposalId, status);
        this.audit.logEvent("interview.proposal_resolved", "candidate", candidateId, {
            proposalId,
            questionId: row.question_id,
            status,
        });
        return { proposal: toProposalDTO(row) };
    }
}
