import { inject, injectable } from "@expressots/core";
import { LlmClient } from "../ai/llm-client";
import {
    GENERATE_QUESTIONS_JSON_SCHEMA,
    GenerateQuestionsResult,
    generateQuestionsZodSchema,
} from "../ai/schemas/generate-questions";
import { CandidateRepository } from "../candidates/candidate.repository";
import {
    ProcessRepository,
    requireActiveProcess,
} from "../process/process.repository";
import { ScoreRepository } from "../scoring/score.repository";
import { parseJsonColumn } from "../scoring/scoring.dto";
import { RateLimiter } from "../security/rate-limit";
import { AuditRepository } from "../shared/audit";
import { AppError } from "../shared/errors";
import { assertValidId } from "../shared/ids";
import {
    MAX_QUESTIONS_PER_CANDIDATE,
    RATE_LIMITS_PER_HOUR,
} from "../shared/limits";
import { QuestionRepository } from "./question.repository";
import {
    GenerateQuestionsResponseDTO,
    parseQuestionCountInput,
    toQuestionDTO,
} from "./questions.dto";

/** Nombre del prompt (prompts/generate-questions.md). */
const QUESTIONS_PROMPT = "generate-questions";

/** Clave del rate limiter para la generación de preguntas (§16: 60/hora). */
export const QUESTIONS_RATE_KEY = "questions";

/**
 * POST /candidates/:id/questions (BLUEPRINT §07, §14).
 *
 * - Requiere candidato ANALIZADO: usa cv_summary como {{cv_summary_json}} y
 *   el análisis persistido (scores + confidence + evidence_summary) como
 *   {{analysis_json}}. DECISIÓN: sin análisis → 400 INVALID_INPUT con
 *   mensaje claro (mismo criterio que analyze sin cv_summary: no existe un
 *   código 409 semánticamente correcto y no se añaden códigos nuevos).
 * - Límite §16: existentes + count ≤ 20 → si no, 422 LIMIT_EXCEEDED.
 * - Persiste cada pregunta con el bloque completo de §14; las señales se
 *   guardan como JSON.
 */
@injectable()
export class GenerateQuestionsUseCase {
    constructor(
        @inject(ProcessRepository)
        private readonly processes: ProcessRepository,
        @inject(CandidateRepository)
        private readonly candidates: CandidateRepository,
        @inject(ScoreRepository) private readonly scores: ScoreRepository,
        @inject(QuestionRepository)
        private readonly questions: QuestionRepository,
        @inject(RateLimiter) private readonly rateLimiter: RateLimiter,
        @inject(LlmClient) private readonly llm: LlmClient,
        @inject(AuditRepository) private readonly audit: AuditRepository,
    ) {}

    async execute(
        id: unknown,
        body: unknown,
    ): Promise<GenerateQuestionsResponseDTO> {
        assertValidId(id);
        const { count } = parseQuestionCountInput(body);

        const active = requireActiveProcess(this.processes);
        const candidate = this.candidates.findActiveInProcess(id, active.id);
        if (!candidate) {
            throw new AppError("NOT_FOUND");
        }

        const score = this.scores.findByCandidate(id);
        if (
            candidate.analysis_status !== "analyzed" ||
            !candidate.cv_summary ||
            !score ||
            score.adaptability === null
        ) {
            throw new AppError(
                "INVALID_INPUT",
                "El candidato aún no está analizado: ejecuta antes el análisis (/analyze).",
            );
        }

        const existing = this.questions.countByCandidate(id);
        if (existing + count > MAX_QUESTIONS_PER_CANDIDATE) {
            throw new AppError(
                "LIMIT_EXCEEDED",
                "Se alcanzaría el máximo de preguntas para este candidato.",
            );
        }

        this.rateLimiter.check(
            QUESTIONS_RATE_KEY,
            RATE_LIMITS_PER_HOUR.QUESTIONS,
        );

        // analysis_json: scores sugeridos + confianza + evidence_summary
        // ({criteria, doubts, risks}) del último análisis.
        const evidenceSummary = parseJsonColumn(score.evidence_summary);
        const analysisJson = JSON.stringify({
            scores: {
                adaptability: score.adaptability,
                fundamentals: score.fundamentals,
                depth: score.depth,
                production: score.production,
                stack: score.stack,
            },
            confidence: score.confidence,
            ...(typeof evidenceSummary === "object" && evidenceSummary !== null
                ? evidenceSummary
                : {}),
        });

        const startedAt = Date.now();
        const result = await this.llm.complete<GenerateQuestionsResult>({
            promptName: QUESTIONS_PROMPT,
            variables: {
                cv_summary_json: candidate.cv_summary,
                analysis_json: analysisJson,
                role_title: active.role_title,
                count: String(count),
            },
            schema: GENERATE_QUESTIONS_JSON_SCHEMA,
            zodSchema: generateQuestionsZodSchema,
        });

        // Si el modelo devolviera más de las pedidas, se recortan: el límite
        // de 20 por candidato jamás se rebasa por exceso del modelo.
        const generated = result.questions.slice(0, count);
        const rows = this.questions.insertMany(id, generated);
        const total = this.questions.countByCandidate(id);

        // Auditoría sin contenido (§17): solo conteos y duración.
        this.audit.logEvent("candidate.questions_generated", "candidate", id, {
            requested: count,
            created: rows.length,
            total,
            durationMs: Date.now() - startedAt,
        });

        return {
            candidateId: id,
            questions: rows.map(toQuestionDTO),
            questionsTotal: total,
            questionsLimit: MAX_QUESTIONS_PER_CANDIDATE,
        };
    }
}
