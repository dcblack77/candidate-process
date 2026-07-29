import { Criterion, CRITERIA } from "../ai/schemas/common";
import { CriterionScores, WEIGHTS } from "../scoring/weights";
import { ExportInclude } from "./export.dto";

/**
 * Construcción del documento markdown de exportación (BLUEPRINT §19).
 *
 * El documento es "limpio y limitado": ranking, score final y por criterio,
 * resumen breve, fortalezas (evidencias explícitas más fuertes), riesgos y
 * preguntas recomendadas. Notas privadas SOLO si include.privateNotes=true.
 * El texto extraído del CV no se persiste, así que nunca puede incluirse.
 */

/** Etiquetas en español de los criterios (§06). */
const CRITERION_LABELS: Record<Criterion, string> = {
    adaptability: "Adaptabilidad",
    fundamentals: "Fundamentos",
    depth: "Profundidad",
    production: "Producción",
    stack: "Stack",
};

/** Datos ya ordenados de un candidato para el export. */
export interface ExportCandidateData {
    position: number;
    name: string;
    finalScore: number;
    scores: CriterionScores;
    confidence: number | null;
    needsManualReview: boolean;
    /** Resumen profesional breve (del cv_summary), si existe. */
    summary: string | null;
    /** Evidencias explícitas más fuertes del análisis. */
    strengths: string[];
    risks: string[];
    /** Preguntas recomendadas (texto). */
    questions: string[];
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
        lines.push("| Posición | Candidato | Score final | Confianza |");
        lines.push("|---:|---|---:|---:|");
        for (const entry of entries) {
            const review = entry.needsManualReview ? " (revisión manual)" : "";
            lines.push(
                `| ${entry.position} | ${entry.name}${review} | ${entry.finalScore.toFixed(2)} | ${formatConfidence(entry.confidence)} |`,
            );
        }
        if (entries.length === 0) {
            lines.push("| — | Sin candidatos puntuados | — | — |");
        }
        lines.push("");
        if (unscoredNames.length > 0) {
            lines.push(`Sin puntuar: ${unscoredNames.join(", ")}.`);
            lines.push("");
        }
        lines.push(`Pesos de la rúbrica: ${WEIGHTS_LINE}.`);
        lines.push("");
    }

    for (const entry of entries) {
        lines.push(`## ${entry.position}. ${entry.name}`);
        lines.push("");
        lines.push(`Score final: **${entry.finalScore.toFixed(2)}**`);
        lines.push("");

        if (include.scoresByCriterion) {
            lines.push("| Criterio | Peso | Score |");
            lines.push("|---|---:|---:|");
            for (const criterion of CRITERIA) {
                lines.push(
                    `| ${CRITERION_LABELS[criterion]} | ${Math.round(WEIGHTS[criterion] * 100)}% | ${entry.scores[criterion]} |`,
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

        if (include.questions && entry.questions.length > 0) {
            lines.push("### Preguntas recomendadas");
            lines.push("");
            for (const question of entry.questions) {
                lines.push(`- ${question}`);
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

/** Línea con los pesos, generada desde WEIGHTS (única fuente). */
const WEIGHTS_LINE = CRITERIA.map(
    (criterion) =>
        `${CRITERION_LABELS[criterion]} ${Math.round(WEIGHTS[criterion] * 100)}%`,
).join(", ");

function formatConfidence(confidence: number | null): string {
    return confidence === null ? "—" : confidence.toFixed(2);
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
