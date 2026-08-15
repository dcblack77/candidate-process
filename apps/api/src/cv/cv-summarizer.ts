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
import { ProcessRow } from "../process/process.repository";
import { AuditRepository } from "../shared/audit";
import { MAX_EXTRACTED_CHARS } from "../shared/limits";

/** Nombre del prompt de resumen (prompts/summarize-cv.md). */
export const SUMMARIZE_PROMPT = "summarize-cv";

/** Lo que devuelve resumir el texto de un CV. */
export interface CvSummaryOutcome {
    /** Caracteres extraídos del CV (antes de truncar). */
    extractedChars: number;
    /** true si el texto se recortó (50k chars o presupuesto de tokens). */
    truncated: boolean;
    /** Resumen estructurado devuelto por el modelo y persistido. */
    summary: SummarizeCvResult;
}

/**
 * Tramo común de "texto extraído → resumen persistido" (BLUEPRINT §05, §11),
 * compartido por la subida uno a uno (`ExtractCvUseCase`) y la carga masiva
 * (`BulkImportCvsUseCase`). GARANTÍAS (§04/§17):
 *
 * - El texto extraído vive SOLO en el argumento `text`: jamás se escribe a
 *   disco, jamás se loguea y jamás se persiste en DB (solo el resumen
 *   estructurado del modelo).
 * - `analysis_status` transita → extracting → summarized; si algo falla tras
 *   empezar queda 'failed', estado reintentable con un nuevo POST.
 * - La auditoría lleva solo métricas (caracteres, truncado, duración).
 */
@injectable()
export class CvSummarizer {
    constructor(
        @inject(ENV) private readonly env: AppEnv,
        @inject(CandidateRepository)
        private readonly candidates: CandidateRepository,
        @inject(LlmClient) private readonly llm: LlmClient,
        @inject(PromptLoader) private readonly prompts: PromptLoader,
        @inject(AuditRepository) private readonly audit: AuditRepository,
    ) {}

    /**
     * Resume `text` para el candidato `candidateId` del proceso `process` y
     * persiste el resultado. Marca 'extracting' al empezar y 'failed' si
     * falla; el error viaja intacto al llamador.
     */
    async summarize(
        candidateId: string,
        text: string,
        process: ProcessRow,
    ): Promise<CvSummaryOutcome> {
        const startedAt = Date.now();
        this.candidates.setAnalysisStatus(candidateId, "extracting");

        const extractedChars = text.length;
        let truncated = false;
        let summary: SummarizeCvResult;
        try {
            const roleTitle = process.role_title;
            const roleContext = process.role_context ?? NEUTRAL_ROLE_CONTEXT;

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
                candidateId,
                JSON.stringify(summary),
                JSON.stringify(summary.evidence),
            );
        } catch (error) {
            // Fallo tras empezar (modelo o parseo): estado 'failed'
            // persistido y reintentable; el error viaja intacto al handler.
            this.candidates.setAnalysisStatus(candidateId, "failed");
            throw error;
        }

        // Auditoría sin contenido (§17): solo métricas y duración.
        this.audit.logEvent("candidate.cv_extracted", "candidate", candidateId, {
            chars: extractedChars,
            truncated,
            durationMs: Date.now() - startedAt,
        });

        return { extractedChars, truncated, summary };
    }
}
