import { Criterion, CRITERIA, EVIDENCE_TYPES } from "../ai/schemas/common";
import { CriterionVerdict } from "../ai/schemas/score-candidate";
import { CriterionInterviewAverage } from "../scoring/interview-score";
import { CriterionScores } from "../scoring/weights";

/**
 * Construcción de `{{candidates_json}}` para `prompts/compare-candidates.md`
 * (BLUEPRINT §15, §18 y §21): lo que el modelo necesita de cada candidato
 * para contrastarlos, y NADA MÁS.
 *
 * Módulo PURO: no toca base de datos ni contenedor.
 *
 * Qué viaja de cada candidato (§18: "enviar solo el texto necesario"):
 * - `ref` y `name`: la referencia corta (C1, C2…) es con la que el modelo
 *   señala candidatos en la salida estructurada (ver ai/schemas/
 *   compare-candidates.ts); el nombre solo sirve para que el texto libre
 *   sea legible.
 * - Resumen profesional y transiciones tecnológicas del resumen del CV.
 * - Por criterio: puntuación, veredicto del contraste con la entrevista,
 *   nota media de entrevista, rationale y evidencias del último análisis
 *   (con su tipo `explicit`/`inferred`, que es lo que permite hablar de
 *   "calidad de evidencia").
 * - Score de CV, score combinado, confianza y dudas pendientes.
 *
 * Qué NO viaja: notas privadas del evaluador, texto de respuestas de
 * entrevista, texto extraído del CV ni las listas de evidencia del resumen
 * (las del análisis ya son las que respaldan la puntuación).
 *
 * PRESUPUESTO DE TOKENS (§18). Con MAX_COMPARISON_CANDIDATES = 5 candidatos y
 * los recortes de abajo, la cota superior por candidato ronda los 7.500
 * caracteres: 5 × 7.500 ≈ 37.500 caracteres ≈ 10.500 tokens, que caben en el
 * presupuesto de entrada (~20.000). El LlmClient vuelve a comprobarlo antes
 * de tocar la red. Todo recorte se marca con "…".
 */

/** Resumen profesional: lo más largo del CV (hasta 1.500) y lo más redundante. */
export const MAX_SUMMARY_CHARS = 800;
/** Rationale de cada criterio del análisis. */
export const MAX_RATIONALE_CHARS = 300;
/** Evidencias por criterio y longitud de cada una. */
export const MAX_EVIDENCE_PER_CRITERION = 3;
export const MAX_EVIDENCE_CHARS = 200;
/** Dudas pendientes y transiciones: cuántas y de qué largo. */
export const MAX_DOUBTS = 5;
export const MAX_DOUBT_CHARS = 200;
export const MAX_TRANSITIONS = 5;
export const MAX_TRANSITION_CHARS = 150;

const ELLIPSIS = "…";

/** Evidencia del análisis con su tipo (§13). */
export interface ComparisonEvidence {
    text: string;
    type: (typeof EVIDENCE_TYPES)[number];
}

/** Todo lo que el caso de uso reúne de un candidato antes de comparar. */
export interface ComparisonCandidateSource {
    ref: string;
    name: string;
    /** `professional_summary` del resumen del CV, si existe. */
    professionalSummary: string | null;
    /** `technology_transitions` del resumen del CV. */
    technologyTransitions: string[];
    scores: CriterionScores;
    cvScore: number;
    overallScore: number;
    provisional: boolean;
    confidence: number | null;
    interviewScore: number | null;
    interviewByCriterion: Record<Criterion, CriterionInterviewAverage | null>;
    verdicts: Record<Criterion, CriterionVerdict | null>;
    /** `evidence_summary.criteria[*].rationale` del último análisis. */
    rationales: Partial<Record<Criterion, string>>;
    /** `evidence_summary.criteria[*].evidence` del último análisis. */
    evidence: Partial<Record<Criterion, ComparisonEvidence[]>>;
    /** `evidence_summary.doubts` del último análisis. */
    doubts: string[];
}

/** Recorta a `max` caracteres marcando el corte con "…". */
export function truncate(text: string, max: number): string {
    if (text.length <= max) {
        return text;
    }
    return text.slice(0, Math.max(0, max - ELLIPSIS.length)) + ELLIPSIS;
}

/** Recorta una lista en número de elementos y en longitud de cada uno. */
function truncateList(
    items: readonly string[],
    maxItems: number,
    maxChars: number,
): string[] {
    return items.slice(0, maxItems).map((item) => truncate(item, maxChars));
}

/**
 * Objeto de un candidato tal y como se serializa en `{{candidates_json}}`.
 * Las claves están en español porque el modelo las lee como texto; los
 * valores numéricos van tal cual (el modelo no los recalcula).
 */
export function toComparisonCandidatePayload(
    source: ComparisonCandidateSource,
): Record<string, unknown> {
    const porCriterio = Object.fromEntries(
        CRITERIA.map((criterion) => {
            const interview = source.interviewByCriterion[criterion];
            return [
                criterion,
                {
                    puntuacion: source.scores[criterion],
                    veredicto_entrevista: source.verdicts[criterion],
                    nota_entrevista: interview ? interview.average : null,
                    justificacion: source.rationales[criterion]
                        ? truncate(
                              source.rationales[criterion] as string,
                              MAX_RATIONALE_CHARS,
                          )
                        : null,
                    evidencias: (source.evidence[criterion] ?? [])
                        .slice(0, MAX_EVIDENCE_PER_CRITERION)
                        .map((item) => ({
                            texto: truncate(item.text, MAX_EVIDENCE_CHARS),
                            tipo: item.type,
                        })),
                },
            ];
        }),
    );

    return {
        ref: source.ref,
        nombre: source.name,
        resumen_profesional: source.professionalSummary
            ? truncate(source.professionalSummary, MAX_SUMMARY_CHARS)
            : null,
        transiciones_tecnologicas: truncateList(
            source.technologyTransitions,
            MAX_TRANSITIONS,
            MAX_TRANSITION_CHARS,
        ),
        score_cv: source.cvScore,
        score_final: source.overallScore,
        score_final_provisional: source.provisional,
        confianza_analisis: source.confidence,
        nota_entrevista_global: source.interviewScore,
        criterios: porCriterio,
        dudas_pendientes: truncateList(
            source.doubts,
            MAX_DOUBTS,
            MAX_DOUBT_CHARS,
        ),
    };
}

/** `{{candidates_json}}` completo: lista JSON de todos los candidatos. */
export function buildCandidatesJson(
    sources: readonly ComparisonCandidateSource[],
): string {
    return JSON.stringify(sources.map(toComparisonCandidatePayload), null, 1);
}
