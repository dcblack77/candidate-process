import { inject, injectable } from "@expressots/core";
import { CandidateRepository } from "../candidates/candidate.repository";
import {
    ProcessRepository,
    requireWritableProcess,
} from "../process/process.repository";
import { RateLimiter } from "../security/rate-limit";
import { AppError } from "../shared/errors";
import { assertValidId } from "../shared/ids";
import { RATE_LIMITS_PER_HOUR } from "../shared/limits";
import {
    CvExtractResponseDTO,
    UploadedCvFile,
    validateUploadedCv,
} from "./cv.dto";
import { CvSummarizer } from "./cv-summarizer";
import { extractText } from "./extractors";

/** Clave del rate limiter para la extracción de CV (§16: 100/hora). */
export const CV_EXTRACT_RATE_KEY = "cv-extract";

/**
 * POST /candidates/:id/cv/extract — pipeline completo del CV (BLUEPRINT §05,
 * §11): archivo en memoria → extracción de texto → truncado → resumen con el
 * modelo local → persistencia del resumen. GARANTÍAS (§04/§17):
 *
 * - El archivo original y el texto extraído viven SOLO en variables locales
 *   de este request: jamás se escriben a disco, jamás se loguean y jamás se
 *   persisten en DB (solo el resumen estructurado del modelo).
 * - `analysis_status` transita pending → extracting → summarized; si algo
 *   falla tras empezar queda 'failed', estado reintentable con un nuevo POST.
 *
 * El tramo "texto → resumen persistido" vive en `CvSummarizer`, compartido
 * con la carga masiva (`BulkImportCvsUseCase`).
 */
@injectable()
export class ExtractCvUseCase {
    constructor(
        @inject(ProcessRepository)
        private readonly processes: ProcessRepository,
        @inject(CandidateRepository)
        private readonly candidates: CandidateRepository,
        @inject(RateLimiter) private readonly rateLimiter: RateLimiter,
        @inject(CvSummarizer) private readonly summarizer: CvSummarizer,
    ) {}

    async execute(
        id: unknown,
        file: UploadedCvFile | undefined,
    ): Promise<CvExtractResponseDTO> {
        assertValidId(id);
        const kind = validateUploadedCv(file);
        const cvFile = file as UploadedCvFile;

        // El candidato debe existir en el proceso seleccionado y no estar borrado.
        const selected = requireWritableProcess(this.processes);
        const candidate = this.candidates.findActiveInProcess(id, selected.id);
        if (!candidate) {
            throw new AppError("NOT_FOUND");
        }

        // Rate limit §16: 100 extracciones/hora. Solo cuenta si la petición
        // superó las validaciones (archivo válido y candidato existente).
        this.rateLimiter.check(
            CV_EXTRACT_RATE_KEY,
            RATE_LIMITS_PER_HOUR.EXTRACT,
        );

        this.candidates.setAnalysisStatus(id, "extracting");

        let text: string;
        try {
            text = await extractText(cvFile.buffer, kind);
        } catch (error) {
            // Archivo ilegible: 'failed' persistido y reintentable.
            this.candidates.setAnalysisStatus(id, "failed");
            throw error;
        }

        const outcome = await this.summarizer.summarize(id, text, selected);

        return {
            candidateId: id,
            analysisStatus: "summarized",
            extractedChars: outcome.extractedChars,
            truncated: outcome.truncated,
            cvSummary: outcome.summary,
            fileDeleted: true,
        };
    }
}
