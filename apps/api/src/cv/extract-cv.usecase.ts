import { inject, injectable } from "@expressots/core";
import {
    estimateTokens,
    LlmClient,
    OUTPUT_MARGIN_TOKENS,
    truncateToBudget,
} from "../ai/llm-client";
import { PromptLoader } from "../ai/prompts";
import { NEUTRAL_ROLE_CONTEXT } from "../ai/role-context";
import {
    SUMMARIZE_CV_JSON_SCHEMA,
    SummarizeCvResult,
    summarizeCvZodSchema,
} from "../ai/schemas/summarize-cv";
import { CandidateRepository } from "../candidates/candidate.repository";
import { AppEnv, ENV } from "../env";
import {
    ProcessRepository,
    requireWritableProcess,
} from "../process/process.repository";
import { RateLimiter } from "../security/rate-limit";
import { AuditRepository } from "../shared/audit";
import { AppError } from "../shared/errors";
import { assertValidId } from "../shared/ids";
import { MAX_EXTRACTED_CHARS, RATE_LIMITS_PER_HOUR } from "../shared/limits";
import {
    CvExtractResponseDTO,
    UploadedCvFile,
    validateUploadedCv,
} from "./cv.dto";
import { extractText } from "./extractors";

/** Nombre del prompt de resumen (prompts/summarize-cv.md). */
const SUMMARIZE_PROMPT = "summarize-cv";

/** Clave del rate limiter para la extracción de CV (§16: 20/hora). */
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
 */
@injectable()
export class ExtractCvUseCase {
    constructor(
        @inject(ENV) private readonly env: AppEnv,
        @inject(ProcessRepository)
        private readonly processes: ProcessRepository,
        @inject(CandidateRepository)
        private readonly candidates: CandidateRepository,
        @inject(RateLimiter) private readonly rateLimiter: RateLimiter,
        @inject(LlmClient) private readonly llm: LlmClient,
        @inject(PromptLoader) private readonly prompts: PromptLoader,
        @inject(AuditRepository) private readonly audit: AuditRepository,
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

        // Rate limit §16: 20 extracciones/hora. Solo cuenta si la petición
        // superó las validaciones (archivo válido y candidato existente).
        this.rateLimiter.check(
            CV_EXTRACT_RATE_KEY,
            RATE_LIMITS_PER_HOUR.EXTRACT,
        );

        const startedAt = Date.now();
        this.candidates.setAnalysisStatus(id, "extracting");

        let extractedChars = 0;
        let truncated = false;
        let summary: SummarizeCvResult;
        try {
            const text = await extractText(cvFile.buffer, kind);
            extractedChars = text.length;

            const roleTitle = selected.role_title;
            const roleContext = selected.role_context ?? NEUTRAL_ROLE_CONTEXT;

            // Doble truncado (plan §Riesgos): 50k chars (§16) y además el
            // presupuesto de tokens del contexto del modelo, descontando el
            // margen de salida y el prompt renderizado sin el cv_text.
            const promptOverhead = estimateTokens(
                this.prompts.render(SUMMARIZE_PROMPT, {
                    cv_text: "",
                    role_title: roleTitle,
                    role_context: roleContext,
                }),
            );
            const tokenBudget =
                this.env.LLM_CONTEXT_TOKENS -
                OUTPUT_MARGIN_TOKENS -
                promptOverhead;
            const cvText = truncateToBudget(
                text.slice(0, MAX_EXTRACTED_CHARS),
                tokenBudget,
            );
            truncated = cvText.length < text.length;

            summary = await this.llm.complete<SummarizeCvResult>({
                promptName: SUMMARIZE_PROMPT,
                variables: {
                    cv_text: cvText,
                    role_title: roleTitle,
                    role_context: roleContext,
                },
                schema: SUMMARIZE_CV_JSON_SCHEMA,
                zodSchema: summarizeCvZodSchema,
            });

            // Se persiste SOLO el resumen estructurado, nunca el texto crudo.
            this.candidates.saveCvSummary(
                id,
                JSON.stringify(summary),
                JSON.stringify(summary.evidence),
            );
        } catch (error) {
            // Fallo tras empezar (parseo o modelo): estado 'failed'
            // persistido y reintentable; el error viaja intacto al handler.
            this.candidates.setAnalysisStatus(id, "failed");
            throw error;
        }

        // Auditoría sin contenido (§17): solo métricas y duración.
        this.audit.logEvent("candidate.cv_extracted", "candidate", id, {
            chars: extractedChars,
            truncated,
            durationMs: Date.now() - startedAt,
        });

        return {
            candidateId: id,
            analysisStatus: "summarized",
            extractedChars,
            truncated,
            cvSummary: summary,
            fileDeleted: true,
        };
    }
}
