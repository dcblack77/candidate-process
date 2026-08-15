import { inject, injectable } from "@expressots/core";
import { LlmClient } from "../ai/llm-client";
import { Criterion, CRITERIA, EVIDENCE_TYPES } from "../ai/schemas/common";
import {
    buildCompareCandidatesSchemas,
    candidateRef,
    CompareCandidatesResult,
} from "../ai/schemas/compare-candidates";
import {
    CandidateRepository,
    CandidateRow,
} from "../candidates/candidate.repository";
import {
    ProcessRepository,
    requireCurrentProcess,
} from "../process/process.repository";
import { QuestionRepository } from "../questions/question.repository";
import { interviewScoreOf } from "../questions/questions.dto";
import {
    CandidateScoreRow,
    ScoreRepository,
} from "../scoring/score.repository";
import { parseJsonColumn, verdictsOf } from "../scoring/scoring.dto";
import {
    computeFinalScore,
    computeOverallScore,
    CriterionScores,
    WEIGHTS,
} from "../scoring/weights";
import { RateLimiter } from "../security/rate-limit";
import { AuditRepository } from "../shared/audit";
import { AppError } from "../shared/errors";
import { RATE_LIMITS_PER_HOUR } from "../shared/limits";
import {
    buildCandidatesJson,
    ComparisonCandidateSource,
    ComparisonEvidence,
} from "./comparison-payload";
import {
    ComparedCandidateDTO,
    ComparisonAnalysisDTO,
    ComparisonResponseDTO,
    parseComparisonInput,
} from "./comparison.dto";

/** Nombre del prompt (prompts/compare-candidates.md). */
const COMPARE_PROMPT = "compare-candidates";

/** Clave del rate limiter para la comparación (§16: 20/hora). */
export const COMPARE_RATE_KEY = "compare";

/** Acción de auditoría de cada comparación generada. */
export const COMPARED_ACTION = "candidates.compared";

/** Recordatorio que viaja en cada respuesta (§01, §23): propone, no decide. */
export const COMPARISON_DISCLAIMER =
    "Comparación cualitativa generada por el modelo local a partir de los " +
    "análisis existentes. Propone matices; no decide contrataciones ni " +
    "sustituye al ranking.";

/**
 * POST /comparison (BLUEPRINT §15, §18 y §21 — vista Comparativa).
 *
 * Compara cualitativamente entre 2 y MAX_COMPARISON_CANDIDATES candidatos
 * del proceso seleccionado con `prompts/compare-candidates.md`. Nace de un
 * dolor concreto: leer los análisis uno a uno no deja ver a dos en paralelo.
 *
 * Decisiones:
 * - Es un caso de uso de LECTURA (`requireCurrentProcess`): no escribe nada
 *   y comparar finalistas de un proceso ya archivado es tan legítimo como
 *   consultar su ranking o exportarlo. La comparación NO se persiste: es un
 *   derivado de los análisis y quedaría obsoleta con cualquier edición de
 *   puntuaciones; el coste de regenerarla lo acota el rate limit.
 * - Exige que todos los candidatos tengan análisis COMPLETO (las cinco
 *   puntuaciones): el prompt contrasta puntuaciones y evidencias, y sin
 *   ellas no habría nada que comparar salvo el nombre. Sin análisis → 400
 *   INVALID_INPUT (mismo criterio que analyze/questions: no se añaden códigos).
 * - Cada candidato entra con una referencia corta (C1, C2…) que el modelo
 *   está OBLIGADO a usar por gramática (enum en el schema); aquí se resuelve
 *   a `candidateId`. Nunca se busca por nombre.
 * - Auditoría sin contenido (§17): cuántos, cuánto tardó y nada más.
 */
@injectable()
export class CompareCandidatesUseCase {
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

    async execute(body: unknown): Promise<ComparisonResponseDTO> {
        const { candidateIds } = parseComparisonInput(body);
        const selected = requireCurrentProcess(this.processes);

        const sources = candidateIds.map((id, index) =>
            this.loadSource(id, selected.id, candidateRef(index)),
        );

        // El rate limit se cobra solo cuando la petición es válida: una
        // comparación rechazada por datos no gasta cupo.
        this.rateLimiter.check(COMPARE_RATE_KEY, RATE_LIMITS_PER_HOUR.COMPARE);

        const refs = sources.map((source) => source.ref);
        const { jsonSchema, zodSchema } = buildCompareCandidatesSchemas(refs);

        const startedAt = Date.now();
        const result = await this.llm.complete<CompareCandidatesResult>({
            promptName: COMPARE_PROMPT,
            variables: {
                candidates_json: buildCandidatesJson(sources),
                role_title: selected.role_title,
            },
            schema: jsonSchema,
            zodSchema,
        });

        this.audit.logEvent(COMPARED_ACTION, "process", selected.id, {
            candidates: sources.length,
            durationMs: Date.now() - startedAt,
        });

        const idByRef = new Map(
            sources.map((source) => [source.ref, source.candidateId]),
        );

        return {
            processId: selected.id,
            roleTitle: selected.role_title,
            generatedAt: new Date().toISOString(),
            weights: WEIGHTS,
            candidates: sources.map(toComparedCandidateDTO),
            comparison: resolveRefs(result, idByRef),
            disclaimer: COMPARISON_DISCLAIMER,
        };
    }

    /**
     * Reúne todo lo que se envía y se devuelve de un candidato. NOT_FOUND si
     * no existe, está borrado o es de otro proceso; INVALID_INPUT si no tiene
     * análisis completo.
     */
    private loadSource(
        id: string,
        processId: string,
        ref: string,
    ): LoadedSource {
        const candidate = this.candidates.findActiveInProcess(id, processId);
        if (!candidate) {
            throw new AppError("NOT_FOUND");
        }
        const score = this.scores.findByCandidate(id);
        if (!score || CRITERIA.some((criterion) => score[criterion] === null)) {
            throw new AppError(
                "INVALID_INPUT",
                "Todos los candidatos deben tener un análisis completo antes de compararlos.",
            );
        }

        const scores = Object.fromEntries(
            CRITERIA.map((criterion) => [criterion, score[criterion] as number]),
        ) as CriterionScores;
        // Defensa en profundidad (igual que en ranking): si la fila viniera de
        // una edición parcial antigua sin final_score, se recalcula aquí.
        const cvScore = score.final_score ?? computeFinalScore(scores);
        const interview = interviewScoreOf(this.questions.listByCandidate(id));
        const overall = computeOverallScore(cvScore, interview.overall);
        const summary = parseCvSummary(candidate);
        const analysis = parseAnalysis(score);

        return {
            ref,
            candidateId: candidate.id,
            name: candidate.name,
            professionalSummary: summary.professionalSummary,
            technologyTransitions: summary.technologyTransitions,
            scores,
            cvScore,
            overallScore: overall.overall,
            provisional: overall.provisional,
            confidence: score.confidence,
            interviewScore: interview.overall,
            interviewByCriterion: interview.byCriterion,
            verdicts: verdictsOf(parseJsonColumn(score.evidence_summary)),
            rationales: analysis.rationales,
            evidence: analysis.evidence,
            doubts: analysis.doubts,
        };
    }
}

/** Fuente del prompt más el id, que el prompt no recibe pero la respuesta sí. */
interface LoadedSource extends ComparisonCandidateSource {
    candidateId: string;
}

function toComparedCandidateDTO(source: LoadedSource): ComparedCandidateDTO {
    return {
        ref: source.ref,
        candidateId: source.candidateId,
        name: source.name,
        scores: source.scores,
        cvScore: source.cvScore,
        overallScore: source.overallScore,
        provisional: source.provisional,
        confidence: source.confidence,
        interviewScore: source.interviewScore,
        interviewByCriterion: source.interviewByCriterion,
        verdicts: source.verdicts,
        pendingDoubts: source.doubts,
    };
}

/**
 * Sustituye las referencias (C1, C2…) por candidateIds. La gramática y zod
 * ya garantizan que toda referencia es una de las enviadas; el filtro es
 * solo defensa en profundidad.
 */
function resolveRefs(
    result: CompareCandidatesResult,
    idByRef: Map<string, string>,
): ComparisonAnalysisDTO {
    const resolve = (refs: string[]): string[] =>
        refs
            .map((ref) => idByRef.get(ref))
            .filter((id): id is string => id !== undefined);

    return {
        criteria: Object.fromEntries(
            CRITERIA.map((criterion) => [
                criterion,
                {
                    leaders: resolve(result.criteria[criterion].leaders),
                    analysis: result.criteria[criterion].analysis,
                },
            ]),
        ) as ComparisonAnalysisDTO["criteria"],
        evidenceQuality: result.evidence_quality,
        profiles: result.profiles,
        ties: result.ties
            .map((tie) => ({
                candidateIds: resolve(tie.candidates),
                whatWouldSeparate: tie.what_would_separate,
            }))
            .filter((tie) => tie.candidateIds.length >= 2),
        openQuestions: result.open_questions,
        summary: result.summary,
    };
}

/** Lo que se aprovecha del resumen del CV: texto profesional y transiciones. */
function parseCvSummary(candidate: CandidateRow): {
    professionalSummary: string | null;
    technologyTransitions: string[];
} {
    const parsed = parseJsonColumn(candidate.cv_summary);
    if (typeof parsed !== "object" || parsed === null) {
        return { professionalSummary: null, technologyTransitions: [] };
    }
    const summary = parsed as {
        professional_summary?: unknown;
        technology_transitions?: unknown;
    };
    return {
        professionalSummary:
            typeof summary.professional_summary === "string"
                ? summary.professional_summary
                : null,
        technologyTransitions: stringList(summary.technology_transitions),
    };
}

/** Rationale, evidencias y dudas del último análisis (evidence_summary). */
function parseAnalysis(score: CandidateScoreRow): {
    rationales: Partial<Record<Criterion, string>>;
    evidence: Partial<Record<Criterion, ComparisonEvidence[]>>;
    doubts: string[];
} {
    const parsed = parseJsonColumn(score.evidence_summary);
    const stored =
        typeof parsed === "object" && parsed !== null
            ? (parsed as { criteria?: unknown; doubts?: unknown })
            : {};
    const criteria =
        typeof stored.criteria === "object" && stored.criteria !== null
            ? (stored.criteria as Record<
                  string,
                  { rationale?: unknown; evidence?: unknown } | undefined
              >)
            : {};

    const rationales: Partial<Record<Criterion, string>> = {};
    const evidence: Partial<Record<Criterion, ComparisonEvidence[]>> = {};
    for (const criterion of CRITERIA) {
        const entry = criteria[criterion];
        if (typeof entry?.rationale === "string" && entry.rationale) {
            rationales[criterion] = entry.rationale;
        }
        if (Array.isArray(entry?.evidence)) {
            evidence[criterion] = entry.evidence.flatMap(toEvidence);
        }
    }
    return { rationales, evidence, doubts: stringList(stored.doubts) };
}

function toEvidence(value: unknown): ComparisonEvidence[] {
    if (typeof value !== "object" || value === null) {
        return [];
    }
    const { text, type } = value as { text?: unknown; type?: unknown };
    if (typeof text !== "string" || text.length === 0) {
        return [];
    }
    const isKnownType =
        typeof type === "string" &&
        (EVIDENCE_TYPES as readonly string[]).includes(type);
    // Una evidencia sin tipo reconocido se trata como inferida: es la lectura
    // conservadora (§13, separar evidencia explícita de inferencia).
    return [
        {
            text,
            type: isKnownType ? (type as ComparisonEvidence["type"]) : "inferred",
        },
    ];
}

function stringList(value: unknown): string[] {
    return Array.isArray(value)
        ? value.filter((item): item is string => typeof item === "string")
        : [];
}
