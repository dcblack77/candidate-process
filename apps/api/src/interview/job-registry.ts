import { injectable } from "@expressots/core";
import { AppErrorCode } from "../shared/errors";
import { MAX_QUEUED_INTERVIEW_ANALYSES } from "../shared/limits";
import { ProposalDTO } from "./interview.dto";

/**
 * Registro EN MEMORIA de los análisis de entrevista (BLUEPRINT §24), con cola.
 *
 * Que el estado del job sea volátil sigue siendo una decisión: todo lo que
 * merece sobrevivir a un reinicio ya está en disco —el audio, la
 * transcripción, las propuestas y `interview_recording.last_status`—, y una
 * tabla de jobs solo duplicaría esas columnas. Lo que se recupera de un
 * análisis caído no es el job, es la grabación, y reintentar es una decisión
 * del evaluador, no un efecto secundario del arranque.
 *
 * Desde el 2026-08-15 hay COLA: sigue ejecutándose UN análisis a la vez —el
 * modelo tiene una cola de concurrencia 1 y whisper corre en CPU, así que dos
 * a la vez solo se estorbarían—, pero el segundo ya no se rechaza con
 * LIMIT_EXCEEDED: espera su turno con posición visible y se puede cancelar
 * mientras tanto. Un job en cola no retiene audio en RAM: la grabación ya
 * está en disco y el runner la lee cuando le toca.
 */

export type JobStatus =
    | "queued"
    | "running"
    | "done"
    | "failed"
    | "cancelled";
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
    /** Grabación sobre la que corre. Es lo que permite reintentar si muere. */
    recordingId: string;
    status: JobStatus;
    phase: JobPhase;
    progress: { done: number; total: number };
    /** Cuándo se ACEPTÓ (entró en cola o arrancó). */
    startedAt: string;
    finishedAt: string | null;
    stats: JobStats | null;
    error: JobError | null;
    /** Propuestas creadas; se rellena al terminar. */
    proposals: ProposalDTO[];
    /** Para cancelar la transcripción en vuelo. No sale en el DTO. */
    controller: AbortController;
    /**
     * Clave del rate limiter que consumió al aceptarse. Sirve para devolver
     * el cupo si se cancela sin haber arrancado o si cae por infraestructura.
     * No sale en el DTO.
     */
    rateKey: string;
}

/** Trabajo que ejecuta el job cuando le llega el turno. */
export type JobRunner = (job: InterviewJob) => Promise<void>;

/** Por qué no se pudo encolar. El llamador lo traduce a un mensaje. */
export type EnqueueRejection = "candidate_busy" | "queue_full";

export type EnqueueResult =
    | { ok: true; job: InterviewJob }
    | { ok: false; reason: EnqueueRejection };

/** Cuánto sobrevive un job terminado antes de olvidarse. */
const COMPLETED_TTL_MS = 15 * 60 * 1000;

@injectable()
export class InterviewJobRegistry {
    private jobs = new Map<string, InterviewJob>();
    /** Ids en orden de llegada. Solo los `queued`. */
    private queue: string[] = [];
    private runners = new Map<string, JobRunner>();

    /**
     * Por qué NO se aceptaría ahora un job de este candidato, o `null` si se
     * aceptaría. Se consulta ANTES de tocar disco: rechazar después de haber
     * guardado el audio dejaría una grabación "interrumpida" que nadie pidió.
     */
    canEnqueue(candidateId: string): EnqueueRejection | null {
        this.forgetExpired();
        if (this.activeForCandidate(candidateId)) {
            // Dos análisis sobre el mismo candidato se pisarían las
            // propuestas (`replaceForRun`).
            return "candidate_busy";
        }
        if (this.queue.length >= MAX_QUEUED_INTERVIEW_ANALYSES) {
            return "queue_full";
        }
        return null;
    }

    /**
     * Acepta un job. Si no hay ninguno corriendo arranca en el acto (el
     * runner se invoca de forma síncrona hasta su primer `await`); si lo hay,
     * se queda en cola. El id lo pone el llamador para poder dejarlo escrito
     * en `interview_recording.last_run_id` antes de que el runner arranque.
     */
    enqueue(
        input: {
            id: string;
            candidateId: string;
            recordingId: string;
            rateKey: string;
        },
        run: JobRunner,
    ): EnqueueResult {
        const rejection = this.canEnqueue(input.candidateId);
        if (rejection) {
            return { ok: false, reason: rejection };
        }
        const job: InterviewJob = {
            id: input.id,
            candidateId: input.candidateId,
            recordingId: input.recordingId,
            status: "queued",
            phase: "transcribing",
            progress: { done: 0, total: 0 },
            startedAt: new Date().toISOString(),
            finishedAt: null,
            stats: null,
            error: null,
            proposals: [],
            controller: new AbortController(),
            rateKey: input.rateKey,
        };
        this.jobs.set(job.id, job);
        this.queue.push(job.id);
        this.runners.set(job.id, run);
        this.pump();
        return { ok: true, job };
    }

    /** El job en ejecución, si lo hay. */
    active(): InterviewJob | undefined {
        return [...this.jobs.values()].find((job) => job.status === "running");
    }

    /** Job vivo (en cola o corriendo) de un candidato, si lo hay. */
    activeForCandidate(candidateId: string): InterviewJob | undefined {
        return [...this.jobs.values()].find(
            (job) =>
                job.candidateId === candidateId &&
                (job.status === "queued" || job.status === "running"),
        );
    }

    /**
     * Posición 1-based en la cola, o `null` si el job no está esperando. Es
     * lo que la pantalla enseña como "hay N por delante".
     */
    queuePosition(id: string): number | null {
        const index = this.queue.indexOf(id);
        return index === -1 ? null : index + 1;
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
     * Cancela un job. Si estaba en cola, sale de ella y nunca llega a correr
     * (devuelve `wasQueued: true` para que el llamador devuelva el cupo del
     * rate limit). Si estaba corriendo, aborta la transcripción en vuelo; el
     * bucle de llamadas al modelo corta en el siguiente límite de llamada,
     * así que puede tardar unos segundos en surtir efecto (LlmClient no
     * acepta AbortSignal).
     */
    cancel(id: string): { job: InterviewJob | undefined; wasQueued: boolean } {
        const job = this.jobs.get(id);
        if (!job || (job.status !== "running" && job.status !== "queued")) {
            return { job, wasQueued: false };
        }
        const wasQueued = job.status === "queued";
        if (wasQueued) {
            this.queue = this.queue.filter((queued) => queued !== id);
            this.runners.delete(id);
        }
        job.controller.abort();
        job.status = "cancelled";
        job.finishedAt = new Date().toISOString();
        return { job, wasQueued };
    }

    /**
     * Arranca el siguiente de la cola si no hay ninguno corriendo. Se llama
     * al encolar y al terminar cada job; es idempotente.
     */
    private pump(): void {
        if (this.active()) {
            return;
        }
        const nextId = this.queue.shift();
        if (!nextId) {
            return;
        }
        const job = this.jobs.get(nextId);
        const run = this.runners.get(nextId);
        this.runners.delete(nextId);
        if (!job || !run || job.status !== "queued") {
            // Cancelado mientras esperaba: al siguiente.
            this.pump();
            return;
        }
        job.status = "running";
        job.startedAt = new Date().toISOString();

        // El runner es responsable de llamar a finish/fail. Si revienta sin
        // hacerlo, el job no puede quedarse en `running` para siempre: eso
        // bloquearía la cola entera.
        void run(job)
            .catch(() => {
                this.fail(job.id, {
                    code: "LLM_UNAVAILABLE",
                    message: "El análisis de la entrevista falló.",
                });
            })
            .finally(() => {
                if (job.status === "running") {
                    this.fail(job.id, {
                        code: "LLM_UNAVAILABLE",
                        message: "El análisis de la entrevista falló.",
                    });
                }
                this.pump();
            });
    }

    /** Olvida los jobs terminados hace rato. Evita que la memoria crezca. */
    private forgetExpired(): void {
        const now = Date.now();
        for (const [id, job] of this.jobs) {
            if (
                job.status !== "running" &&
                job.status !== "queued" &&
                job.finishedAt !== null &&
                now - Date.parse(job.finishedAt) > COMPLETED_TTL_MS
            ) {
                this.jobs.delete(id);
            }
        }
    }
}
