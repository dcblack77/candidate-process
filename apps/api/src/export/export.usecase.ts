import { inject, injectable } from "@expressots/core";
import { Criterion, CRITERIA } from "../ai/schemas/common";
import { CandidateRepository } from "../candidates/candidate.repository";
import {
    ProcessRepository,
    requireCurrentProcess,
} from "../process/process.repository";
import { QuestionRepository } from "../questions/question.repository";
import { interviewScoreOf } from "../questions/questions.dto";
import { InterviewScore } from "../scoring/interview-score";
import {
    CandidateScoreRow,
    ScoreRepository,
} from "../scoring/score.repository";
import { parseJsonColumn, verdictsOf } from "../scoring/scoring.dto";
import {
    computeFinalScore,
    CriterionScores,
    CV_WEIGHT,
    INTERVIEW_WEIGHT,
    rankEntries,
    WEIGHTS,
} from "../scoring/weights";
import { AuditRepository } from "../shared/audit";
import { AppError } from "../shared/errors";
import { MAX_EXPORTS_PER_SESSION } from "../shared/limits";
import { ExportSessionCounter } from "./export-session";
import { ExportResponseDTO, parseExportInput } from "./export.dto";
import {
    buildExportFilename,
    buildExportMarkdown,
    ExportCandidateData,
    ExportQuestionData,
} from "./markdown-builder";
import { toExportCandidateDTOs } from "./structured-builder";

/** Máximo de fortalezas (evidencias explícitas) por candidato en el export. */
const MAX_STRENGTHS = 5;

/**
 * POST /export (BLUEPRINT §19): genera el documento markdown para el líder.
 *
 * - Defaults seguros (§17): privateNotes y extractedText NUNCA por defecto.
 * - privateNotes=true añade las notas Y registra 'export.included_sensitive'.
 * - DECISIÓN documentada: extractedText se acepta como clave pero se ignora
 *   porque el texto extraído no se persiste (§04); si llega a true, el
 *   markdown incluye una nota explicándolo y NO cuenta como dato sensible.
 * - Límite §16: 10 exportaciones por hora (ventana deslizante en memoria),
 *   compartido por los dos formatos.
 * - La API NO escribe en disco: devuelve contenido y filename y la UI descarga.
 *
 * Dos formatos sobre EL MISMO cálculo (`format`, default 'markdown'):
 * `markdown` devuelve el documento ya escrito y `structured` devuelve los
 * mismos datos en JSON para la vista de impresión del navegador (§19: el PDF
 * lo genera el navegador, sin librerías nuevas ni escritura en disco). La
 * selección de datos y el filtrado por `include` son idénticos: solo cambia
 * la serialización final.
 */
@injectable()
export class ExportUseCase {
    constructor(
        @inject(ProcessRepository)
        private readonly processes: ProcessRepository,
        @inject(CandidateRepository)
        private readonly candidates: CandidateRepository,
        @inject(ScoreRepository) private readonly scores: ScoreRepository,
        @inject(QuestionRepository)
        private readonly questions: QuestionRepository,
        @inject(ExportSessionCounter)
        private readonly session: ExportSessionCounter,
        @inject(AuditRepository) private readonly audit: AuditRepository,
    ) {}

    execute(body: unknown): ExportResponseDTO {
        const { include, format } = parseExportInput(body);
        const selected = requireCurrentProcess(this.processes);

        if (this.session.count >= MAX_EXPORTS_PER_SESSION) {
            throw new AppError(
                "LIMIT_EXCEEDED",
                "Se alcanzó el máximo de exportaciones por hora. Espera un poco antes de exportar de nuevo.",
            );
        }

        const unscoredNames: string[] = [];
        const rankable: Array<{
            candidateId: string;
            name: string;
            score: CandidateScoreRow;
            summary: string | null;
            scores: CriterionScores;
            cvScore: number;
            questions: ExportQuestionData[];
            interview: InterviewScore;
            interviewScore: number | null;
            confidence: number | null;
        }> = [];

        for (const candidate of this.candidates.listActive(selected.id)) {
            const score = this.scores.findByCandidate(candidate.id);
            if (
                !score ||
                CRITERIA.some((criterion) => score[criterion] === null)
            ) {
                unscoredNames.push(candidate.name);
                continue;
            }
            const criterionScores = Object.fromEntries(
                CRITERIA.map((criterion) => [
                    criterion,
                    score[criterion] as number,
                ]),
            ) as CriterionScores;
            const questionRows = this.questions.listByCandidate(candidate.id);
            const interview = interviewScoreOf(questionRows);
            rankable.push({
                candidateId: candidate.id,
                name: candidate.name,
                score,
                summary: professionalSummaryOf(candidate.cv_summary),
                scores: criterionScores,
                cvScore:
                    score.final_score ?? computeFinalScore(criterionScores),
                questions: questionRows.map((question) => ({
                    question: question.question,
                    answerScore: question.answer_score,
                    // Texto privado: el builder solo lo escribe con
                    // include.privateNotes=true.
                    answerNotes: question.answer_notes,
                })),
                interview,
                interviewScore: interview.overall,
                confidence: score.confidence,
            });
        }

        const entries: ExportCandidateData[] = rankEntries(rankable).map(
            (entry) => ({
                position: entry.position,
                name: entry.name,
                cvScore: entry.cvScore,
                overallScore: entry.overallScore,
                provisional: entry.provisional,
                scores: entry.scores,
                confidence: entry.confidence,
                needsManualReview: entry.needsManualReview,
                summary: entry.summary,
                strengths: strengthsOf(entry.score, entry.scores),
                risks: risksOf(entry.score),
                doubts: doubtsOf(entry.score),
                verdicts: verdictsOf(parseJsonColumn(entry.score.evidence_summary)),
                questions: entry.questions,
                interview: entry.interview,
                manualNotes: entry.score.manual_notes,
            }),
        );

        const generatedAt = new Date();
        const date = generatedAt.toISOString().slice(0, 10);

        const exportsUsed = this.session.increment();
        const sensitiveIncluded = include.privateNotes;
        if (sensitiveIncluded) {
            this.audit.logEvent(
                "export.included_sensitive",
                "process",
                selected.id,
                {
                    privateNotes: true,
                    format,
                },
            );
        }
        this.audit.logEvent("export.generated", "process", selected.id, {
            candidatesIncluded: entries.length,
            sensitiveIncluded,
            format,
        });

        const usage = {
            exportsUsedThisSession: exportsUsed,
            exportsLimit: MAX_EXPORTS_PER_SESSION,
        };

        if (format === "structured") {
            return {
                format: "structured",
                filename: buildExportFilename(selected.role_title, date, "pdf"),
                generatedAt: generatedAt.toISOString(),
                roleTitle: selected.role_title,
                roleContext: selected.role_context,
                weights: WEIGHTS,
                scoreWeights: { cv: CV_WEIGHT, interview: INTERVIEW_WEIGHT },
                entries: toExportCandidateDTOs(entries, include),
                unscored: unscoredNames,
                include,
                ...usage,
            };
        }

        return {
            format: "markdown",
            filename: buildExportFilename(selected.role_title, date, "md"),
            content: buildExportMarkdown({
                roleTitle: selected.role_title,
                date,
                include,
                entries,
                unscoredNames,
            }),
            ...usage,
        };
    }
}

/** professional_summary del cv_summary persistido, si existe. */
function professionalSummaryOf(cvSummaryJson: string | null): string | null {
    const parsed = parseJsonColumn(cvSummaryJson);
    if (typeof parsed !== "object" || parsed === null) {
        return null;
    }
    const summary = (parsed as Record<string, unknown>).professional_summary;
    return typeof summary === "string" && summary.length > 0 ? summary : null;
}

/** Forma persistida de evidence_summary: {criteria, doubts, risks}. */
interface StoredEvidenceSummary {
    criteria?: Partial<
        Record<
            Criterion,
            { evidence?: Array<{ text?: unknown; type?: unknown }> }
        >
    >;
    doubts?: unknown;
    risks?: unknown;
}

function storedSummary(score: CandidateScoreRow): StoredEvidenceSummary {
    const parsed = parseJsonColumn(score.evidence_summary);
    return typeof parsed === "object" && parsed !== null
        ? (parsed as StoredEvidenceSummary)
        : {};
}

/**
 * Fortalezas (§19): las evidencias EXPLÍCITAS del análisis, recorriendo los
 * criterios de mayor a menor score del candidato (las más fuertes primero).
 */
function strengthsOf(
    score: CandidateScoreRow,
    scores: CriterionScores,
): string[] {
    const criteria = storedSummary(score).criteria ?? {};
    const byScoreDesc = [...CRITERIA].sort((a, b) => scores[b] - scores[a]);
    const strengths: string[] = [];
    for (const criterion of byScoreDesc) {
        for (const item of criteria[criterion]?.evidence ?? []) {
            if (item?.type === "explicit" && typeof item.text === "string") {
                strengths.push(item.text);
                if (strengths.length >= MAX_STRENGTHS) {
                    return strengths;
                }
            }
        }
    }
    return strengths;
}

function risksOf(score: CandidateScoreRow): string[] {
    return stringListOf(storedSummary(score).risks);
}

/** Dudas pendientes de validar en entrevista (§13), como en el ranking. */
function doubtsOf(score: CandidateScoreRow): string[] {
    return stringListOf(storedSummary(score).doubts);
}

function stringListOf(value: unknown): string[] {
    return Array.isArray(value)
        ? value.filter((item): item is string => typeof item === "string")
        : [];
}
