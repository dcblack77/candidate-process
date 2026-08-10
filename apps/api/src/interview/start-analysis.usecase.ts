import { inject, injectable } from "@expressots/core";
import { LlmClient } from "../ai/llm-client";
import { SttClient } from "../ai/stt-client";
import { CandidateRepository } from "../candidates/candidate.repository";
import { AppEnv, ENV } from "../env";
import {
    ProcessRepository,
    ProcessRow,
    requireWritableProcess,
} from "../process/process.repository";
import { QuestionRepository } from "../questions/question.repository";
import { RateLimiter } from "../security/rate-limit";
import { AuditRepository } from "../shared/audit";
import { AppError, AppErrorCode } from "../shared/errors";
import { assertValidId, newId } from "../shared/ids";
import {
    MAX_RECORDINGS_PER_CANDIDATE,
    RATE_LIMITS_PER_HOUR,
} from "../shared/limits";
import { AudioTrack } from "./audio-upload.middleware";
import { AnalysisSource, runInterviewAnalysis } from "./analysis-runner";
import {
    InterviewAnalysisOptions,
    toProposalDTO,
} from "./interview.dto";
import { InterviewJobRegistry } from "./job-registry";
import { ProposalRepository } from "./proposal.repository";
import {
    parseTracks,
    RecordingRepository,
    RecordingRow,
} from "./recording.repository";
import {
    readTracks,
    readTranscript,
    saveTracks,
    saveTranscript,
} from "./recording-store";

/** Clave del rate limiter para el análisis de entrevista (§16: 6/hora). */
export const INTERVIEW_RATE_KEY = "interview";

/**
 * POST /candidates/:id/interview/analysis (BLUEPRINT §24).
 *
 * Responde 202 con el id del job y sigue trabajando en segundo plano: el
 * análisis tarda minutos y ningún request HTTP debe vivir tanto.
 *
 * Desde el 2026-08-10 el audio se guarda en disco ANTES de lanzar el job, y
 * la transcripción en cuanto whisper responde. Motivo: el job vive en memoria
 * y cuando moría a medias se perdía el trabajo Y el audio —el navegador no lo
 * conservaba—, así que no había forma de reintentar sobre una entrevista que
 * ya había ocurrido. Ahora un fallo es un reintento (`resume`), no una pérdida.
 */
@injectable()
export class StartAnalysisUseCase {
    constructor(
        @inject(ProcessRepository)
        private readonly processes: ProcessRepository,
        @inject(CandidateRepository)
        private readonly candidates: CandidateRepository,
        @inject(QuestionRepository)
        private readonly questions: QuestionRepository,
        @inject(ProposalRepository)
        private readonly proposals: ProposalRepository,
        @inject(RecordingRepository)
        private readonly recordings: RecordingRepository,
        @inject(InterviewJobRegistry)
        private readonly jobs: InterviewJobRegistry,
        @inject(RateLimiter) private readonly rateLimiter: RateLimiter,
        @inject(SttClient) private readonly stt: SttClient,
        @inject(LlmClient) private readonly llm: LlmClient,
        @inject(AuditRepository) private readonly audit: AuditRepository,
        @inject(ENV) private readonly env: AppEnv,
    ) {}

    /** Sube audio nuevo: lo guarda en disco y lanza el primer análisis. */
    execute(
        candidateId: unknown,
        tracks: AudioTrack[],
        options: InterviewAnalysisOptions,
    ): { jobId: string; recordingId: string; startedAt: string; total: number } {
        assertValidId(candidateId);

        if (tracks.length === 0) {
            throw new AppError(
                "INVALID_INPUT",
                "Sube al menos una pista de audio de la entrevista.",
            );
        }

        const context = this.prepare(candidateId, options);

        if (
            this.recordings.countByCandidate(candidateId) >=
            MAX_RECORDINGS_PER_CANDIDATE
        ) {
            throw new AppError(
                "LIMIT_EXCEEDED",
                `Este candidato ya tiene ${MAX_RECORDINGS_PER_CANDIDATE} grabaciones guardadas. Borra alguna antes de subir otra.`,
            );
        }

        const job = this.claimJob(candidateId);

        // El audio va a disco ANTES de arrancar el trabajo: si el proceso
        // muere en el siguiente segundo, la grabación sigue estando.
        const recordingId = newId();
        const stored = saveTracks(this.env.RECORDINGS_DIR, recordingId, tracks);
        const recording = this.recordings.create({
            id: recordingId,
            candidateId,
            processId: context.processId,
            candidateSource: options.candidateSource,
            tracks: stored,
            runId: job.id,
        });

        void this.run(job.id, recording, { kind: "audio", tracks }, context);

        return {
            jobId: job.id,
            recordingId: recording.id,
            startedAt: job.startedAt,
            total: context.questions.length,
        };
    }

    /**
     * Relanza el análisis sobre una grabación ya guardada. Es la razón de ser
     * de todo esto: si hay transcripción en disco arranca desde ella y se
     * ahorra los minutos de whisper; si el job murió antes de transcribir,
     * relee el audio.
     */
    resume(
        candidateId: unknown,
        recordingId: unknown,
        options: InterviewAnalysisOptions,
    ): { jobId: string; recordingId: string; startedAt: string; total: number } {
        assertValidId(candidateId);
        assertValidId(recordingId);

        // La pertenencia de la grabación se comprueba ANTES que las preguntas
        // o el rate limit: pedir un recurso que no es tuyo tiene que responder
        // 404 y no un error sobre el estado del candidato ajeno.
        const selected = this.requireCandidate(candidateId);
        const recording = this.recordings.findByIdForCandidate(
            recordingId,
            candidateId,
        );
        if (!recording) {
            throw new AppError("NOT_FOUND");
        }

        const context = this.prepare(candidateId, options, selected);
        const source = this.sourceFor(recording);
        const job = this.claimJob(candidateId);
        this.recordings.markRun(recording.id, job.id, "running");

        void this.run(job.id, recording, source, context);

        return {
            jobId: job.id,
            recordingId: recording.id,
            startedAt: job.startedAt,
            total: context.questions.length,
        };
    }

    /**
     * Elige de dónde sale la transcripción de un reanálisis. La transcripción
     * guardada manda siempre: es el mismo texto que produjo whisper y evita
     * repetir el paso más caro del pipeline.
     */
    private sourceFor(recording: RecordingRow): AnalysisSource {
        const transcript = readTranscript(
            this.env.RECORDINGS_DIR,
            recording.id,
        );
        if (transcript) {
            return { kind: "transcript", ...transcript };
        }

        const stored = parseTracks(recording);
        if (stored.length === 0) {
            throw new AppError(
                "NOT_FOUND",
                "Esta grabación ya no tiene audio ni transcripción utilizables.",
            );
        }
        return {
            kind: "audio",
            tracks: readTracks(this.env.RECORDINGS_DIR, recording.id, stored),
        };
    }

    /**
     * Validaciones comunes a lanzar y relanzar: proceso escribible, candidato
     * vivo, preguntas pendientes y rate limit. Se hacen ANTES de tocar disco
     * o de ocupar el job.
     */
    /**
     * Proceso escribible + el candidato vivo dentro de él. Se separa de
     * {@link prepare} para poder intercalar la comprobación de pertenencia de
     * la grabación entre medias.
     */
    private requireCandidate(candidateId: string): ProcessRow {
        const selected = requireWritableProcess(this.processes);
        const candidate = this.candidates.findActiveInProcess(
            candidateId,
            selected.id,
        );
        if (!candidate) {
            throw new AppError("NOT_FOUND");
        }
        return selected;
    }

    private prepare(
        candidateId: string,
        options: InterviewAnalysisOptions,
        process?: ProcessRow,
    ): AnalysisContext {
        const selected = process ?? this.requireCandidate(candidateId);

        const all = this.questions.listByCandidate(candidateId);
        if (all.length === 0) {
            throw new AppError(
                "LIMIT_EXCEEDED",
                "Este candidato no tiene preguntas de entrevista: genéralas antes de analizar el audio.",
            );
        }
        const pending = options.includeAnswered
            ? all
            : all.filter((question) => question.answer_score === null);
        if (pending.length === 0) {
            throw new AppError(
                "LIMIT_EXCEEDED",
                "Todas las preguntas de este candidato ya están puntuadas.",
            );
        }

        this.rateLimiter.check(
            INTERVIEW_RATE_KEY,
            RATE_LIMITS_PER_HOUR.INTERVIEW,
        );

        return {
            candidateId,
            processId: selected.id,
            questions: pending,
            roleTitle: selected.role_title,
            roleContext: selected.role_context,
        };
    }

    private claimJob(candidateId: string): { id: string; startedAt: string } {
        const job = this.jobs.start(candidateId);
        if (!job) {
            throw new AppError(
                "LIMIT_EXCEEDED",
                "Ya hay un análisis de entrevista en curso. Espera a que termine o cancélalo.",
            );
        }
        return job;
    }

    private async run(
        jobId: string,
        recording: RecordingRow,
        source: AnalysisSource,
        context: AnalysisContext,
    ): Promise<void> {
        const job = this.jobs.find(jobId);
        const startedAt = Date.now();
        const tracks = source.kind === "audio" ? source.tracks : [];
        try {
            const result = await runInterviewAnalysis(
                {
                    source,
                    questions: context.questions,
                    roleTitle: context.roleTitle,
                    roleContext: context.roleContext,
                },
                {
                    stt: this.stt,
                    llm: this.llm,
                    signal: job?.controller.signal,
                    // Se persiste ANTES de la primera llamada al modelo: a
                    // partir de aquí un fallo ya no cuesta transcribir de nuevo.
                    onTranscribed: (transcript) => {
                        saveTranscript(
                            this.env.RECORDINGS_DIR,
                            recording.id,
                            transcript,
                        );
                        this.recordings.markTranscribed(
                            recording.id,
                            transcript.durationSec,
                            transcript.segments.length,
                        );
                    },
                    onProgress: (progress) =>
                        this.jobs.updateProgress(
                            jobId,
                            progress.phase,
                            progress.done,
                            progress.total,
                        ),
                },
            );

            const rows = this.proposals.replaceForRun(
                context.candidateId,
                jobId,
                result.proposals,
            );
            this.jobs.finish(jobId, result.stats, rows.map(toProposalDTO));
            // El estado real lo manda el registro: un job cancelado en el
            // último momento no se "completa" y la grabación no debe decir
            // que sí.
            this.recordings.markRun(
                recording.id,
                jobId,
                this.jobs.find(jobId)?.status === "cancelled"
                    ? "cancelled"
                    : "done",
            );

            // Auditoría SIN contenido (§17): solo conteos y duraciones.
            this.audit.logEvent(
                "interview.analyzed",
                "candidate",
                context.candidateId,
                {
                    jobId,
                    recordingId: recording.id,
                    resumed: source.kind === "transcript",
                    audioSec: result.stats.durationSec,
                    segments: result.stats.segments,
                    chunks: result.stats.chunks,
                    questionsAssessed: result.stats.questionsAssessed,
                    llmCalls: result.stats.llmCalls,
                    demoted: result.stats.demoted,
                    routingFailures: result.stats.routingFailures,
                    durationMs: Date.now() - startedAt,
                },
            );
        } catch (error) {
            const code: AppErrorCode =
                error instanceof AppError ? error.code : "LLM_UNAVAILABLE";
            const message =
                error instanceof AppError
                    ? error.message
                    : "El análisis de la entrevista falló.";
            this.jobs.fail(jobId, { code, message });
            // La grabación queda marcada como fallida y sigue en disco: es
            // justo el caso que motivó persistirla, así que reintentar tiene
            // que ser posible desde la pantalla.
            this.recordings.markRun(
                recording.id,
                jobId,
                this.jobs.find(jobId)?.status === "cancelled"
                    ? "cancelled"
                    : "failed",
                code,
            );
        } finally {
            // Copia en RAM fuera. El audio persistido en disco no se toca.
            for (const track of tracks) {
                track.audio.fill(0);
            }
        }
    }
}

/** Contexto ya validado de un análisis, común a lanzar y relanzar. */
interface AnalysisContext {
    candidateId: string;
    processId: string;
    questions: ReturnType<QuestionRepository["listByCandidate"]>;
    roleTitle: string;
    roleContext: string | null;
}
