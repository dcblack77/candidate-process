import { inject, injectable } from "@expressots/core";
import { LlmClient } from "../ai/llm-client";
import { NO_ANALYSIS_AVAILABLE } from "../ai/analysis-context";
import { NEUTRAL_ROLE_CONTEXT } from "../ai/role-context";
import {
    GENERATE_QUESTIONS_JSON_SCHEMA,
    GenerateQuestionsResult,
    generateQuestionsZodSchema,
} from "../ai/schemas/generate-questions";
import { CandidateRepository } from "../candidates/candidate.repository";
import {
    ProcessRepository,
    requireWritableProcess,
} from "../process/process.repository";
import { CandidateScoreRow, ScoreRepository } from "../scoring/score.repository";
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
import { trimToSingleQuestion } from "./trim-question";
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
 * - Requiere únicamente el **CV procesado** (`cv_summary`). El análisis es
 *   OPCIONAL (decisión del 2026-08-07): con el resumen del CV y el contexto
 *   del rol ya hay material para preguntar. Antes se exigía análisis previo,
 *   lo que gastaba una de las 5 regeneraciones por candidato (§16) solo para
 *   poder generar preguntas. Sin `cv_summary` → 400 INVALID_INPUT (mismo
 *   criterio que analyze: no hay código 409 semánticamente correcto y no se
 *   añaden códigos nuevos).
 * - Si el análisis EXISTE se aprovecha: sus dudas y sus criterios flojos son
 *   la primera fuente de preguntas. Si no, el prompt recibe
 *   {@link NO_ANALYSIS_AVAILABLE} y se apoya solo en el CV.
 * - Límite §16: existentes + count ≤ 20 → si no, 422 LIMIT_EXCEEDED.
 * - Persiste cada pregunta con el bloque de §14; las señales como JSON.
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

        const selected = requireWritableProcess(this.processes);
        const candidate = this.candidates.findActiveInProcess(id, selected.id);
        if (!candidate) {
            throw new AppError("NOT_FOUND");
        }

        if (!candidate.cv_summary) {
            throw new AppError(
                "INVALID_INPUT",
                "Este candidato aún no tiene el CV procesado: súbelo antes de generar preguntas.",
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

        const score = this.scores.findByCandidate(id);
        const analysisJson = buildAnalysisJson(score);

        const startedAt = Date.now();
        const result = await this.llm.complete<GenerateQuestionsResult>({
            promptName: QUESTIONS_PROMPT,
            variables: {
                cv_summary_json: candidate.cv_summary,
                analysis_json: analysisJson,
                role_title: selected.role_title,
                role_context: selected.role_context ?? NEUTRAL_ROLE_CONTEXT,
                count: String(count),
            },
            schema: GENERATE_QUESTIONS_JSON_SCHEMA,
            zodSchema: generateQuestionsZodSchema,
        });

        // Si el modelo devolviera más de las pedidas, se recortan: el límite
        // de 20 por candidato jamás se rebasa por exceso del modelo. Y de cada
        // una se deja una sola interrogación (ver trim-question.ts).
        const generated = result.questions
            .slice(0, count)
            .map((question) => ({
                ...question,
                question: trimToSingleQuestion(question.question),
            }));
        const rows = this.questions.insertMany(id, generated);
        const total = this.questions.countByCandidate(id);

        // Auditoría sin contenido (§17): solo conteos, duración y si las
        // preguntas se apoyaron o no en un análisis previo.
        this.audit.logEvent("candidate.questions_generated", "candidate", id, {
            requested: count,
            created: rows.length,
            total,
            withAnalysis: analysisJson !== NO_ANALYSIS_AVAILABLE,
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

/**
 * {{analysis_json}}: scores sugeridos + confianza + evidence_summary
 * ({criteria, doubts, risks}) del último análisis.
 *
 * Una fila de score sin `adaptability` es un análisis a medias (por ejemplo,
 * solo notas manuales): cuenta como "sin análisis" para no mandar al modelo
 * un objeto de puntuaciones lleno de nulos.
 */
function buildAnalysisJson(score: CandidateScoreRow | undefined): string {
    if (!score || score.adaptability === null) {
        return NO_ANALYSIS_AVAILABLE;
    }

    const evidenceSummary = parseJsonColumn(score.evidence_summary);
    return JSON.stringify({
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
}
