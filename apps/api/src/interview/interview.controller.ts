import {
    body,
    controller,
    Delete,
    Get,
    Http,
    param,
    Patch,
    Post,
    request,
} from "@expressots/adapter-express";
import { inject } from "@expressots/core";
import { Request } from "express";
import {
    canDeleteData,
    canEditScores,
    canTranscribeInterview,
    requirePermission,
} from "../security/permissions";
import {
    scrubUploadedAudio,
    takeAudioOwnership,
    uploadInterviewAudioMiddleware,
} from "./audio-upload.middleware";
import {
    CancelAnalysisUseCase,
    GetAnalysisUseCase,
    InterviewAnalysisDTO,
    UpdateProposalUseCase,
} from "./get-analysis.usecase";
import {
    parseAnalysisOptions,
    parseResumeOptions,
    ProposalDTO,
    RecordingDTO,
} from "./interview.dto";
import {
    DeleteRecordingUseCase,
    ListRecordingsUseCase,
} from "./recordings.usecase";
import { StartAnalysisUseCase } from "./start-analysis.usecase";

/** Respuesta común de lanzar y relanzar un análisis. */
interface StartedAnalysisDTO {
    candidateId: string;
    jobId: string;
    /** Grabación sobre la que corre. Sirve para reintentar si esto falla. */
    recordingId: string;
    /** `queued` si hay otro análisis corriendo: espera su turno (§24). */
    status: "queued" | "running";
    phase: "transcribing";
    progress: { done: number; total: number };
    /** Cuántos hay por delante si está en cola; `null` si ya corre. */
    queuePosition: number | null;
    startedAt: string;
}

/**
 * Rutas del análisis de entrevista (BLUEPRINT §24).
 *
 * Cuelgan de `/candidates/:id/interview` porque siempre operan sobre un
 * candidato del proceso seleccionado. Permisos (§09): lanzar y cancelar el
 * análisis usan `canTranscribeInterview`; resolver una propuesta usa
 * `canEditScores`, porque es una decisión de evaluación.
 */
@controller("/candidates/:id/interview")
export class InterviewController {
    constructor(
        @inject(StartAnalysisUseCase)
        private readonly startAnalysis: StartAnalysisUseCase,
        @inject(GetAnalysisUseCase)
        private readonly getAnalysis: GetAnalysisUseCase,
        @inject(CancelAnalysisUseCase)
        private readonly cancelAnalysis: CancelAnalysisUseCase,
        @inject(UpdateProposalUseCase)
        private readonly updateProposal: UpdateProposalUseCase,
        @inject(ListRecordingsUseCase)
        private readonly recordings: ListRecordingsUseCase,
        @inject(DeleteRecordingUseCase)
        private readonly recordingRemoval: DeleteRecordingUseCase,
    ) {}

    /**
     * Sube el audio y lanza el análisis. Responde 202 enseguida: el trabajo
     * dura minutos y se sigue con GET.
     */
    @Post("/analysis", uploadInterviewAudioMiddleware)
    @Http(202)
    start(
        @request() req: Request,
        @param("id") candidateId: string,
    ): StartedAnalysisDTO {
        try {
            requirePermission(canTranscribeInterview, req.currentUser);
            const options = parseAnalysisOptions(
                (req.body as Record<string, unknown> | undefined)?.meta,
            );
            // A partir de aquí el dueño del audio es el job, no el request.
            const tracks = takeAudioOwnership(req, options.candidateSource);
            const started = this.startAnalysis.execute(
                candidateId,
                tracks,
                options,
            );
            return {
                candidateId,
                jobId: started.jobId,
                recordingId: started.recordingId,
                status: started.status,
                phase: "transcribing",
                progress: { done: 0, total: started.total },
                queuePosition: started.queuePosition,
                startedAt: started.startedAt,
            };
        } finally {
            // Red de seguridad: si algo falló antes de transferir la
            // propiedad, la copia en RAM no sobrevive al request. El audio ya
            // guardado en disco es otra cosa y se borra aparte (§24).
            scrubUploadedAudio(req);
        }
    }

    /**
     * Relanza el análisis sobre una grabación ya guardada. Sin subida: el
     * audio y —si el intento anterior llegó a terminarla— la transcripción ya
     * están en disco.
     */
    @Post("/analysis/from/:recordingId")
    @Http(202)
    resume(
        @request() req: Request,
        @param("id") candidateId: string,
        @param("recordingId") recordingId: string,
        @body() payload: unknown,
    ): StartedAnalysisDTO {
        requirePermission(canTranscribeInterview, req.currentUser);
        const { includeAnswered } = parseResumeOptions(payload);
        const started = this.startAnalysis.resume(candidateId, recordingId, {
            // La atribución de hablante no se puede cambiar al reanalizar: la
            // transcripción guardada ya la lleva aplicada.
            candidateSource: "tab",
            includeAnswered,
        });
        return {
            candidateId,
            jobId: started.jobId,
            recordingId: started.recordingId,
            status: started.status,
            phase: "transcribing",
            progress: { done: 0, total: started.total },
            queuePosition: started.queuePosition,
            startedAt: started.startedAt,
        };
    }

    /** Grabaciones conservadas de este candidato. */
    @Get("/recordings")
    listRecordings(
        @request() req: Request,
        @param("id") candidateId: string,
    ): { recordings: RecordingDTO[] } {
        requirePermission(canTranscribeInterview, req.currentUser);
        return this.recordings.execute(candidateId);
    }

    /**
     * Borra una grabación: archivos y fila. Usa `canDeleteData` y no
     * `canTranscribeInterview` porque destruye datos de forma irreversible.
     */
    @Delete("/recordings/:recordingId")
    @Http(200)
    deleteRecording(
        @request() req: Request,
        @param("id") candidateId: string,
        @param("recordingId") recordingId: string,
    ): { id: string; deleted: true } {
        requirePermission(canDeleteData, req.currentUser);
        return this.recordingRemoval.execute(candidateId, recordingId);
    }

    @Get("/analysis/:jobId")
    get(
        @request() req: Request,
        @param("id") candidateId: string,
        @param("jobId") jobId: string,
    ): InterviewAnalysisDTO {
        requirePermission(canTranscribeInterview, req.currentUser);
        return this.getAnalysis.execute(candidateId, jobId);
    }

    @Delete("/analysis/:jobId")
    @Http(200)
    cancel(
        @request() req: Request,
        @param("id") candidateId: string,
        @param("jobId") jobId: string,
    ): InterviewAnalysisDTO {
        requirePermission(canTranscribeInterview, req.currentUser);
        return this.cancelAnalysis.execute(candidateId, jobId);
    }

    @Patch("/proposals/:proposalId")
    @Http(200)
    resolve(
        @request() req: Request,
        @param("id") candidateId: string,
        @param("proposalId") proposalId: string,
        @body() payload: unknown,
    ): { proposal: ProposalDTO } {
        requirePermission(canEditScores, req.currentUser);
        return this.updateProposal.execute(candidateId, proposalId, payload);
    }
}
