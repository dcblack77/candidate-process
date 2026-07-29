import { Criterion, CRITERIA } from "../ai/schemas/common";
import { WEIGHTS } from "./weights";

/**
 * Agregación de las notas de las respuestas de entrevista (BLUEPRINT §07 y
 * §15). Módulo PURO: no toca base de datos ni contenedor.
 *
 * - Cada pregunta puede llevar una nota entera de 1 a 10 (10 = la respuesta
 *   que más se ajusta a lo esperado).
 * - Media por criterio sobre las preguntas puntuadas de ese criterio.
 * - Global: media ponderada con los pesos de la rúbrica (weights.ts sigue
 *   siendo la ÚNICA fuente de pesos) RENORMALIZANDO sobre los criterios que
 *   tienen al menos una respuesta puntuada. Ejemplo: si solo hay respuestas
 *   de adaptabilidad (0.30) y stack (0.10), el global es
 *   (media_adaptabilidad * 0.30 + media_stack * 0.10) / 0.40.
 * - Sin ninguna respuesta puntuada, el global es null.
 *
 * Esta nota NO entra en la fórmula del score final (§06): solo se usa como
 * criterio de desempate del ranking (§15) y como información del detalle.
 */

/** Valor mínimo de la nota de una respuesta. */
export const MIN_ANSWER_SCORE = 1;

/** Valor máximo de la nota de una respuesta (la más ajustada a lo esperado). */
export const MAX_ANSWER_SCORE = 10;

/** Entrada mínima del agregador: criterio de la pregunta y nota (o null). */
export interface AnsweredQuestion {
    criterion: string;
    answerScore: number | null;
}

/** Media de un criterio y cuántas respuestas la sostienen. */
export interface CriterionInterviewAverage {
    /** Media 1-10 redondeada a 1 decimal. */
    average: number;
    /** Número de respuestas puntuadas de ese criterio. */
    answered: number;
}

/** Agregados de entrevista de un candidato. */
export interface InterviewScore {
    /** Media por criterio; null en los criterios sin ninguna respuesta puntuada. */
    byCriterion: Record<Criterion, CriterionInterviewAverage | null>;
    /** Global ponderado y renormalizado (1-10, 1 decimal); null si no hay notas. */
    overall: number | null;
    /** Preguntas con nota. */
    answeredCount: number;
    /** Preguntas totales del candidato. */
    totalCount: number;
}

/** Redondeo a 1 decimal, sin residuos de coma flotante. */
function round1(value: number): number {
    return Math.round(value * 10) / 10;
}

function isValidCriterion(criterion: string): criterion is Criterion {
    return (CRITERIA as readonly string[]).includes(criterion);
}

/**
 * Calcula {@link InterviewScore} a partir de las preguntas de un candidato.
 * Función pura y determinista.
 *
 * DECISIÓN: el global se calcula sobre las medias SIN redondear y solo se
 * redondea el resultado, para no arrastrar el error de los redondeos por
 * criterio. Las medias por criterio sí se exponen redondeadas a 1 decimal.
 */
export function computeInterviewScore(
    questions: AnsweredQuestion[],
): InterviewScore {
    const sums = new Map<Criterion, { total: number; answered: number }>();
    let answeredCount = 0;

    for (const question of questions) {
        const { criterion, answerScore } = question;
        // Defensivo: el criterio viene de una columna con CHECK, pero el
        // agregador no asume nada sobre su origen.
        if (answerScore === null || !isValidCriterion(criterion)) {
            continue;
        }
        const accumulator = sums.get(criterion) ?? { total: 0, answered: 0 };
        accumulator.total += answerScore;
        accumulator.answered += 1;
        sums.set(criterion, accumulator);
        answeredCount += 1;
    }

    const byCriterion = {} as Record<
        Criterion,
        CriterionInterviewAverage | null
    >;
    let weightedTotal = 0;
    let weightSum = 0;

    for (const criterion of CRITERIA) {
        const accumulator = sums.get(criterion);
        if (!accumulator || accumulator.answered === 0) {
            byCriterion[criterion] = null;
            continue;
        }
        const rawAverage = accumulator.total / accumulator.answered;
        byCriterion[criterion] = {
            average: round1(rawAverage),
            answered: accumulator.answered,
        };
        weightedTotal += rawAverage * WEIGHTS[criterion];
        weightSum += WEIGHTS[criterion];
    }

    return {
        byCriterion,
        // Renormalización sobre los criterios presentes.
        overall: weightSum > 0 ? round1(weightedTotal / weightSum) : null,
        answeredCount,
        totalCount: questions.length,
    };
}

/** Agregados vacíos (candidato sin preguntas). Útil para respuestas uniformes. */
export function emptyInterviewScore(): InterviewScore {
    return computeInterviewScore([]);
}
