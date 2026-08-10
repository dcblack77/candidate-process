import { injectable } from "@expressots/core";
import { AppErrorCode } from "../shared/errors";
import { newId } from "../shared/ids";
import { ProposalDTO } from "./interview.dto";

/**
 * Registro EN MEMORIA de los análisis de entrevista en curso (BLUEPRINT §24).
 *
 * Que el estado sea volátil es una decisión, no una carencia: persistirlo
 * obligaría a guardar la transcripción en `data/local.db`, que es justo lo
 * que §17 prohíbe para el dato más sensible que maneja el sistema. El precio
 * —un reinicio del backend a mitad de análisis lo pierde— está asumido y
 * documentado.
 *
 * Solo un análisis a la vez: cada uno ocupa la cola del modelo varios minutos
 * y whisper corre en CPU. Un segundo simultáneo solo haría más lentos a los
 * dos.
 */

export type JobStatus = "running" | "done" | "failed" | "cancelled";
export type JobPhase =
    | "transcribing"
    | "routing"
    | "assessing"
    | "done";

export interface JobError {
    code: AppErrorCode;
    message: string;
}

export interface JobStats {
    durationSec: number;
    segments: number;
    chunks: number;
    questionsAssessed: number;
    llmCalls: number;
    /** Cuántas propuestas bajó de nivel el verificador de citas. */
    demoted: number;
    /** Fragmentos cuyo enrutado falló y cayeron al respaldo léxico. */
    routingFailures: number;
}

export interface InterviewJob {
    id: string;
    candidateId: string;
    status: JobStatus;
    phase: JobPhase;
    progress: { done: number; total: number };
    startedAt: string;
    finishedAt: string | null;
    stats: JobStats | null;
    error: JobError | null;
    /** Propuestas creadas; se rellena al terminar. */
    proposals: ProposalDTO[];
    /** Para cancelar la transcripción en vuelo. No sale en el DTO. */
    controller: AbortController;
}

/** Cuánto sobrevive un job terminado antes de olvidarse. */
const COMPLETED_TTL_MS = 15 * 60 * 1000;

@injectable()
export class InterviewJobRegistry {
    private jobs = new Map<string, InterviewJob>();

    /**
     * Crea un job y lo marca en curso. Devuelve `null` si ya hay otro vivo:
     * el llamador lo traduce a LIMIT_EXCEEDED con un mensaje propio.
     */
    start(candidateId: string): InterviewJob | null {
        this.forgetExpired();
        if (this.active()) {
            return null;
        }
        const job: InterviewJob = {
            id: newId(),
            candidateId,
            status: "running",
            phase: "transcribing",
            progress: { done: 0, total: 0 },
            startedAt: new Date().toISOString(),
            finishedAt: null,
            stats: null,
            error: null,
            proposals: [],
            controller: new AbortController(),
        };
        this.jobs.set(job.id, job);
        return job;
    }

    /** El job en curso, si lo hay. */
    active(): InterviewJob | undefined {
        return [...this.jobs.values()].find((job) => job.status === "running");
    }

    find(id: string): InterviewJob | undefined {
        this.forgetExpired();
        return this.jobs.get(id);
    }

    updateProgress(
        id: string,
        phase: JobPhase,
        done: number,
        total: number,
    ): void {
        const job = this.jobs.get(id);
        if (!job || job.status !== "running") {
            return;
        }
        job.phase = phase;
        job.progress = { done, total };
    }

    finish(id: string, stats: JobStats, proposals: ProposalDTO[]): void {
        const job = this.jobs.get(id);
        if (!job) {
            return;
        }
        // Un job cancelado no se "completa" después: el usuario ya decidió.
        if (job.status === "cancelled") {
            return;
        }
        job.status = "done";
        job.phase = "done";
        job.stats = stats;
        job.proposals = proposals;
        job.finishedAt = new Date().toISOString();
    }

    fail(id: string, error: JobError): void {
        const job = this.jobs.get(id);
        if (!job || job.status === "cancelled") {
            return;
        }
        job.status = "failed";
        job.error = error;
        job.finishedAt = new Date().toISOString();
    }

    /**
     * Cancela un job. Aborta la transcripción en vuelo; el bucle de llamadas
     * al modelo corta en el siguiente límite de llamada, así que puede tardar
     * unos segundos en surtir efecto (LlmClient no acepta AbortSignal).
     */
    cancel(id: string): InterviewJob | undefined {
        const job = this.jobs.get(id);
        if (!job || job.status !== "running") {
            return job;
        }
        job.controller.abort();
        job.status = "cancelled";
        job.finishedAt = new Date().toISOString();
        return job;
    }

    /** Olvida los jobs terminados hace rato. Evita que la memoria crezca. */
    private forgetExpired(): void {
        const now = Date.now();
        for (const [id, job] of this.jobs) {
            if (
                job.status !== "running" &&
                job.finishedAt !== null &&
                now - Date.parse(job.finishedAt) > COMPLETED_TTL_MS
            ) {
                this.jobs.delete(id);
            }
        }
    }
}
