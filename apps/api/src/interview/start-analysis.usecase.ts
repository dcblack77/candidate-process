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
    MAX_QUEUED_INTERVIEW_ANALYSES,
    MAX_RECORDINGS_PER_CANDIDATE,
    RATE_LIMITS_PER_HOUR,
} from "../shared/limits";
import { AudioTrack } from "./audio-upload.middleware";
import { AnalysisSource, runInterviewAnalysis } from "./analysis-runner";
import {
    InterviewAnalysisOptions,
    toProposalDTO,
} from "./interview.dto";
import {
    EnqueueRejection,
    InterviewJob,
    InterviewJobRegistry,
} from "./job-registry";
import { ProposalRepository } from "./proposal.repository";
import {
    parseTracks,
    RecordingRepository,
    RecordingRow,
} from "./recording.repository";
import {
    readTracks,
    readTranscript,
    removeRecording,
    saveTracks,
    saveTranscript,
} from "./recording-store";

/**
 * Claves del rate limiter (§16). `INTERVIEW` cubre lo que transcribe (6/h,
 * ~15 min de CPU cada uno); `INTERVIEW_REANALYSIS` cubre el reanálisis desde
 * una transcripción guardada (20/h, solo modelo). Son dos cupos porque son dos
 * costes distintos: cobrar el barato contra el caro dejaba sin sitio a quien
 * reintentaba tras un fallo del modelo.
 */
export const INTERVIEW_RATE_KEY = "interview";
export const INTERVIEW_REANALYSIS_RATE_KEY = "interview_reanalysis";

/** Lo que devuelven lanzar y relanzar: el job aceptado y dónde corre. */
export interface StartedAnalysis {
    jobId: string;
    recordingId: string;
    status: "queued" | "running";
    queuePosition: number | null;
    startedAt: string;
    total: number;
}

/**
 * POST /candidates/:id/interview/analysis (BLUEPRINT §24).
 *
 * Responde 202 con el id del job y sigue trabajando en segundo plano: el
 * análisis tarda minutos y ningún request HTTP debe vivir tanto.
 *
 * Desde el 2026-08-10 el audio se guarda en disco ANTES de aceptar el job, y
 * la transcripción en cuanto whisper responde. Motivo: el job vive en memoria
 * y cuando moría a medias se perdía el trabajo Y el audio —el navegador no lo
 * conservaba—, así que no había forma de reintentar sobre una entrevista que
 * ya había ocurrido. Ahora un fallo es un reintento (`resume`), no una pérdida.
 *
 * Desde el 2026-08-15 el job puede quedar EN COLA si hay otro corriendo: el
 * runner lee el audio (o la transcripción) del disco cuando le toca, así que
 * un job esperando no retiene nada en RAM y la copia que subió el navegador
 * se pone a cero en cuanto está guardada.
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

    /** Sube audio nuevo: lo guarda en disco y acepta el primer análisis. */
    execute(
        candidateId: unknown,
        tracks: AudioTrack[],
        options: InterviewAnalysisOptions,
    ): StartedAnalysis {
        assertValidId(candidateId);

        if (tracks.length === 0) {
            throw new AppError(
                "INVALID_INPUT",
                "Sube al menos una pista de audio de la entrevista.",
            );
        }

        const selected = this.requireCandidate(candidateId);
        if (
            this.recordings.countByCandidate(candidateId) >=
            MAX_RECORDINGS_PER_CANDIDATE
        ) {
            throw new AppError(
                "LIMIT_EXCEEDED",
                `Este candidato ya tiene ${MAX_RECORDINGS_PER_CANDIDATE} grabaciones guardadas. Borra alguna antes de subir otra.`,
            );
        }
        const context = this.prepare(
            candidateId,
            options,
            INTERVIEW_RATE_KEY,
            selected,
        );

        // El audio va a disco ANTES de aceptar el trabajo: si el proceso
        // muere en el siguiente segundo, la grabación sigue estando. Y la
        // copia que subió el navegador deja de hacer falta en el acto: el
        // runner leerá el archivo cuando le toque, esté en cola o no.
        const jobId = newId();
        const recordingId = newId();
        const stored = saveTracks(this.env.RECORDINGS_DIR, recordingId, tracks);
        for (const track of tracks) {
            track.audio.fill(0);
        }
        const recording = this.recordings.create({
            id: recordingId,
            candidateId,
            processId: context.processId,
            candidateSource: options.candidateSource,
            tracks: stored,
            runId: jobId,
        });

        try {
            return this.accept(jobId, recording, context, INTERVIEW_RATE_KEY);
        } catch (error) {
            // No debería pasar —`prepare` ya consultó a la cola y entre medias
            // no hay ningún await—, pero si pasa no puede quedar en disco una
            // grabación que nadie va a analizar y que la pantalla enseñaría
            // como "interrumpida".
            removeRecording(this.env.RECORDINGS_DIR, recording.id);
            this.recordings.delete(recording.id);
            throw error;
        }
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
    ): StartedAnalysis {
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
        if (parseTracks(recording).length === 0 && !recording.transcript_at) {
            throw new AppError(
                "NOT_FOUND",
                "Esta grabación ya no tiene audio ni transcripción utilizables.",
            );
        }

        // Con transcripción guardada el reanálisis es solo modelo: va contra
        // el cupo barato. Sin ella hay que volver a pasar por whisper.
        const rateKey = recording.transcript_at
            ? INTERVIEW_REANALYSIS_RATE_KEY
            : INTERVIEW_RATE_KEY;
        const context = this.prepare(candidateId, options, rateKey, selected);
        const jobId = newId();
        this.recordings.markRun(recording.id, jobId, "running");
        return this.accept(jobId, recording, context, rateKey);
    }

    /**
     * Mete el job en la cola (o lo arranca si está libre) y traduce el
     * rechazo, que a estas alturas no debería producirse porque `prepare` ya
     * preguntó.
     */
    private accept(
        jobId: string,
        recording: RecordingRow,
        context: AnalysisContext,
        rateKey: string,
    ): StartedAnalysis {
        const result = this.jobs.enqueue(
            {
                id: jobId,
                candidateId: context.candidateId,
                recordingId: recording.id,
                rateKey,
            },
            (job) => this.run(job, context),
        );
        if (!result.ok) {
            this.rateLimiter.refund(rateKey);
            throw enqueueError(result.reason);
        }
        return {
            jobId: result.job.id,
            recordingId: recording.id,
            status: result.job.status === "queued" ? "queued" : "running",
            queuePosition: this.jobs.queuePosition(result.job.id),
            startedAt: result.job.startedAt,
            total: context.pendingAtSubmission,
        };
    }

    /**
     * Elige de dónde sale la transcripción. Se resuelve cuando el job
     * ARRANCA, no cuando se acepta: así un job en cola no retiene audio en
     * RAM. La transcripción guardada manda siempre: es el mismo texto que
     * produjo whisper y evita repetir el paso más caro del pipeline.
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

    /**
     * Validaciones comunes a lanzar y relanzar: proceso escribible, candidato
     * vivo, preguntas pendientes, hueco en la cola y rate limit. Se hacen
     * ANTES de tocar disco o de aceptar el job, y el rate limit va el ÚLTIMO:
     * un rechazo no debe gastar cupo.
     */
    private prepare(
        candidateId: string,
        options: InterviewAnalysisOptions,
        rateKey: string,
        process?: ProcessRow,
    ): AnalysisContext {
        const selected = process ?? this.requireCandidate(candidateId);
        const pending = this.pendingQuestions(candidateId, options);

        const rejection = this.jobs.canEnqueue(candidateId);
        if (rejection) {
            throw enqueueError(rejection);
        }

        this.rateLimiter.check(rateKey, RATE_LIMITS_PER_HOUR[
            rateKey === INTERVIEW_REANALYSIS_RATE_KEY
                ? "INTERVIEW_REANALYSIS"
                : "INTERVIEW"
        ]);

        return {
            candidateId,
            processId: selected.id,
            includeAnswered: options.includeAnswered,
            pendingAtSubmission: pending.length,
        };
    }

    /**
     * Preguntas que se van a evaluar. Se calcula al aceptar (para rechazar
     * con un mensaje claro) y OTRA VEZ al arrancar: un job puede esperar
     * minutos en cola y mientras tanto el evaluador puede haber puntuado a
     * mano; proponer nota para una pregunta ya cerrada sería ruido.
     */
    private pendingQuestions(
        candidateId: string,
        options: Pick<InterviewAnalysisOptions, "includeAnswered">,
    ): ReturnType<QuestionRepository["listByCandidate"]> {
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
        return pending;
    }

    private async run(job: InterviewJob, context: AnalysisContext): Promise<void> {
        const jobId = job.id;
        const startedAt = Date.now();
        let source: AnalysisSource | undefined;
        try {
            // Todo lo que puede haber cambiado mientras esperaba en cola se
            // relee ahora: la grabación (¿la borraron?), las preguntas (¿las
            // puntuaron a mano?) y el contexto del rol.
            const recording = this.recordings.findById(job.recordingId);
            if (!recording) {
                throw new AppError(
                    "NOT_FOUND",
                    "La grabación se borró antes de que empezara el análisis.",
                );
            }
            const process = this.processes.findById(context.processId);
            if (!process) {
                throw new AppError("NOT_FOUND");
            }
            const questions = this.pendingQuestions(context.candidateId, {
                includeAnswered: context.includeAnswered,
            });
            source = this.sourceFor(recording);

            const result = await runInterviewAnalysis(
                {
                    source,
                    questions,
                    roleTitle: process.role_title,
                    roleContext: process.role_context,
                },
                {
                    stt: this.stt,
                    llm: this.llm,
                    signal: job.controller.signal,
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
            // que ser posible desde la pantalla. (Si la borraron mientras
            // esperaba, ya no hay fila que marcar.)
            if (this.recordings.findById(job.recordingId)) {
                this.recordings.markRun(
                    job.recordingId,
                    jobId,
                    this.jobs.find(jobId)?.status === "cancelled"
                        ? "cancelled"
                        : "failed",
                    code,
                );
            }
            // Si la transcripción no estaba disponible, el cupo caro no se
            // gastó en nada: se devuelve para que reintentar no espere una
            // hora. Cancelar NO devuelve nada (whisper ya trabajó, o casi),
            // aunque la cancelación se manifieste como un fallo del STT.
            if (
                code === "STT_UNAVAILABLE" &&
                this.jobs.find(jobId)?.status !== "cancelled"
            ) {
                this.rateLimiter.refund(job.rateKey);
            }
        } finally {
            // Copia en RAM fuera. El audio persistido en disco no se toca.
            if (source?.kind === "audio") {
                for (const track of source.tracks) {
                    track.audio.fill(0);
                }
            }
        }
    }
}

/** Traducción del rechazo de la cola a un error con mensaje accionable. */
function enqueueError(reason: EnqueueRejection): AppError {
    return reason === "candidate_busy"
        ? new AppError(
              "LIMIT_EXCEEDED",
              "Este candidato ya tiene un análisis de entrevista en curso o en cola. Espera a que termine o cancélalo.",
          )
        : new AppError(
              "LIMIT_EXCEEDED",
              `Ya hay ${MAX_QUEUED_INTERVIEW_ANALYSES} análisis de entrevista esperando. Inténtalo cuando termine alguno.`,
          );
}

/**
 * Contexto ya validado de un análisis, común a lanzar y relanzar. Guarda lo
 * que hace falta para RELEER al arrancar, no una foto de las preguntas: entre
 * aceptarse y ejecutarse puede pasar un buen rato en cola.
 */
interface AnalysisContext {
    candidateId: string;
    processId: string;
    includeAnswered: boolean;
    /** Preguntas pendientes cuando se aceptó; solo informa el `total` inicial. */
    pendingAtSubmission: number;
}
