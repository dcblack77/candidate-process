import { Criterion, CRITERIA } from "../ai/schemas/common";
import { CriterionVerdict } from "../ai/schemas/score-candidate";
import { InterviewScore } from "../scoring/interview-score";
import {
    CriterionScores,
    CV_WEIGHT,
    INTERVIEW_WEIGHT,
    WEIGHTS,
} from "../scoring/weights";
import { ExportInclude } from "./export.dto";

/**
 * Construcción del documento markdown de exportación (BLUEPRINT §19).
 *
 * El documento es "limpio y limitado": ranking (score de CV, nota de
 * entrevista y score final combinado), score por criterio con el veredicto
 * del contraste, resumen breve, fortalezas (evidencias explícitas más
 * fuertes), riesgos y preguntas recomendadas. Notas privadas SOLO si
 * include.privateNotes=true. El texto extraído del CV no se persiste, así que
 * nunca puede incluirse.
 *
 * Entrevista: las NOTAS NUMÉRICAS (global, por criterio y por pregunta) sí
 * salen en el export normal — son puntuación, no texto sensible. El TEXTO de
 * las notas de respuesta es dato privado (§17) y solo se escribe con
 * include.privateNotes=true, igual que las notas del evaluador.
 */

/** Etiquetas en español de los criterios (§06). */
const CRITERION_LABELS: Record<Criterion, string> = {
    adaptability: "Adaptabilidad",
    fundamentals: "Fundamentos",
    depth: "Profundidad",
    production: "Producción",
    stack: "Stack",
};

/** Etiqueta del veredicto del contraste CV/entrevista (§13). */
const VERDICT_LABELS: Record<CriterionVerdict, string> = {
    confirmed: "✓ confirmado",
    not_demonstrated: "⚠ no demostrado",
    contradicted: "⚠ contradicho",
    not_assessed: "—",
};

/** Pregunta recomendada y, si la hay, la evaluación de su respuesta. */
export interface ExportQuestionData {
    question: string;
    /** Nota 1-10 de la respuesta; null si no está puntuada. */
    answerScore: number | null;
    /** Texto privado de la respuesta: solo se usa si include.privateNotes=true. */
    answerNotes: string | null;
}

/** Datos ya ordenados de un candidato para el export. */
export interface ExportCandidateData {
    position: number;
    name: string;
    /** Score de la rúbrica §06 (1-5): lo que promete el CV. */
    cvScore: number;
    /** Score final combinado 30% CV / 70% entrevista (§06). */
    overallScore: number;
    /** true si aún no tiene entrevista puntuada (combinado = score de CV). */
    provisional: boolean;
    scores: CriterionScores;
    /** Veredicto del contraste por criterio; null en análisis antiguos. */
    verdicts: Record<Criterion, CriterionVerdict | null>;
    confidence: number | null;
    needsManualReview: boolean;
    /** Resumen profesional breve (del cv_summary), si existe. */
    summary: string | null;
    /** Evidencias explícitas más fuertes del análisis. */
    strengths: string[];
    risks: string[];
    /** Preguntas recomendadas con la evaluación de su respuesta. */
    questions: ExportQuestionData[];
    /** Agregados de las notas de entrevista (numéricos, no sensibles). */
    interview: InterviewScore;
    /** Notas privadas: solo se usan si include.privateNotes=true. */
    manualNotes: string | null;
}

export interface ExportDocumentParams {
    roleTitle: string;
    /** Fecha ISO yyyy-mm-dd. */
    date: string;
    include: ExportInclude;
    entries: ExportCandidateData[];
    /** Nombres de candidatos sin puntuación (fuera del ranking). */
    unscoredNames: string[];
}

/** Genera el markdown del export (§19). Determinista para una misma entrada. */
export function buildExportMarkdown(params: ExportDocumentParams): string {
    const { roleTitle, date, include, entries, unscoredNames } = params;
    const lines: string[] = [];

    lines.push(`# Evaluación de candidatos — ${roleTitle}`);
    lines.push("");
    lines.push(`Fecha: ${date}`);
    lines.push("");

    if (include.extractedText) {
        lines.push(
            "> Nota: el texto extraído de los CVs no se conserva en el sistema " +
                "(el CV original se elimina tras el resumen), por lo que no puede incluirse.",
        );
        lines.push("");
    }

    if (include.ranking) {
        lines.push("## Ranking");
        lines.push("");
        lines.push(
            "| Posición | Candidato | CV | Entrevista | Score final | Confianza |",
        );
        lines.push("|---:|---|---:|---:|---:|---:|");
        for (const entry of entries) {
            const review = entry.needsManualReview ? " (revisión manual)" : "";
            // El asterisco marca los provisionales; se explica bajo la tabla.
            const overall = `${entry.overallScore.toFixed(2)}${entry.provisional ? "*" : ""}`;
            lines.push(
                `| ${entry.position} | ${entry.name}${review} | ${entry.cvScore.toFixed(2)} | ${formatInterview(entry.interview.overall)} | ${overall} | ${formatConfidence(entry.confidence)} |`,
            );
        }
        if (entries.length === 0) {
            lines.push("| — | Sin candidatos puntuados | — | — | — | — |");
        }
        lines.push("");
        if (unscoredNames.length > 0) {
            lines.push(`Sin puntuar: ${unscoredNames.join(", ")}.`);
            lines.push("");
        }
        lines.push(`Score final = ${SCORE_WEIGHTS_LINE}.`);
        lines.push("");
        lines.push(
            "\\* Score provisional: el candidato aún no tiene respuestas de " +
                "entrevista puntuadas, así que su score final es solo el del CV.",
        );
        lines.push("");
        lines.push(`Pesos de la rúbrica (score de CV): ${WEIGHTS_LINE}.`);
        lines.push("");
    }

    for (const entry of entries) {
        lines.push(`## ${entry.position}. ${entry.name}`);
        lines.push("");
        lines.push(
            `Score final: **${entry.overallScore.toFixed(2)}**` +
                `${entry.provisional ? " (provisional: sin entrevista puntuada)" : ""}` +
                ` — CV ${entry.cvScore.toFixed(2)} · Entrevista ${formatInterview(entry.interview.overall)}/10 · ${SCORE_WEIGHTS_LINE}`,
        );
        lines.push("");

        if (include.scoresByCriterion) {
            lines.push("| Criterio | Peso | Score | Entrevista |");
            lines.push("|---|---:|---:|---|");
            for (const criterion of CRITERIA) {
                const verdict = entry.verdicts[criterion];
                lines.push(
                    `| ${CRITERION_LABELS[criterion]} | ${Math.round(WEIGHTS[criterion] * 100)}% | ${entry.scores[criterion]} | ${verdict === null ? "—" : VERDICT_LABELS[verdict]} |`,
                );
            }
            lines.push("");
        }

        if (include.summary && entry.summary) {
            lines.push("### Resumen");
            lines.push("");
            lines.push(entry.summary);
            lines.push("");
        }

        if (include.strengths) {
            lines.push("### Fortalezas");
            lines.push("");
            if (entry.strengths.length > 0) {
                for (const strength of entry.strengths) {
                    lines.push(`- ${strength}`);
                }
            } else {
                lines.push("- Sin evidencias explícitas destacadas.");
            }
            lines.push("");
        }

        if (include.risks) {
            lines.push("### Riesgos");
            lines.push("");
            if (entry.risks.length > 0) {
                for (const risk of entry.risks) {
                    lines.push(`- ${risk}`);
                }
            } else {
                lines.push("- Sin riesgos identificados.");
            }
            lines.push("");
        }

        // Notas de entrevista: solo si hay al menos una respuesta puntuada
        // (el documento debe seguir siendo "limpio y limitado", §19).
        if (entry.interview.answeredCount > 0) {
            lines.push("### Entrevista");
            lines.push("");
            lines.push(
                `Nota global de entrevista: **${formatInterview(entry.interview.overall)}** / 10 ` +
                    `(${entry.interview.answeredCount} de ${entry.interview.totalCount} respuestas puntuadas).`,
            );
            lines.push("");
            lines.push("| Criterio | Nota media | Respuestas |");
            lines.push("|---|---:|---:|");
            for (const criterion of CRITERIA) {
                const average = entry.interview.byCriterion[criterion];
                lines.push(
                    `| ${CRITERION_LABELS[criterion]} | ${average === null ? "—" : average.average.toFixed(1)} | ${average?.answered ?? 0} |`,
                );
            }
            lines.push("");
        }

        if (include.questions && entry.questions.length > 0) {
            lines.push("### Preguntas recomendadas");
            lines.push("");
            for (const question of entry.questions) {
                const score =
                    question.answerScore === null
                        ? ""
                        : ` (nota de la respuesta: ${question.answerScore}/10)`;
                lines.push(`- ${question.question}${score}`);
                // El TEXTO de la respuesta es dato privado (§17).
                if (include.privateNotes && question.answerNotes) {
                    lines.push(
                        `  - Respuesta anotada: ${question.answerNotes}`,
                    );
                }
            }
            lines.push("");
        }

        if (include.privateNotes && entry.manualNotes) {
            lines.push("### Notas privadas");
            lines.push("");
            lines.push(entry.manualNotes);
            lines.push("");
        }
    }

    return lines.join("\n");
}

/** Línea con los pesos de la rúbrica, desde WEIGHTS (única fuente). */
const WEIGHTS_LINE = CRITERIA.map(
    (criterion) =>
        `${CRITERION_LABELS[criterion]} ${Math.round(WEIGHTS[criterion] * 100)}%`,
).join(", ");

/** Línea con los pesos del combinado, desde weights.ts (única fuente). */
const SCORE_WEIGHTS_LINE =
    `CV ${Math.round(CV_WEIGHT * 100)}% + ` +
    `entrevista ${Math.round(INTERVIEW_WEIGHT * 100)}% (nota /2, escala 1-5)`;

function formatConfidence(confidence: number | null): string {
    return confidence === null ? "—" : confidence.toFixed(2);
}

/** Nota de entrevista con 1 decimal; "—" si el candidato no tiene ninguna. */
function formatInterview(overall: number | null): string {
    return overall === null ? "—" : overall.toFixed(1);
}

/**
 * Nombre de archivo del export: `export-<slug-del-rol>-<yyyy-mm-dd>.md`.
 * El slug elimina diacríticos y todo lo que no sea alfanumérico.
 */
export function buildExportFilename(roleTitle: string, date: string): string {
    const slug =
        roleTitle
            .normalize("NFD")
            .replace(/[\u0300-\u036f]/g, "")
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-+|-+$/g, "") || "proceso";
    return `export-${slug}-${date}.md`;
}
