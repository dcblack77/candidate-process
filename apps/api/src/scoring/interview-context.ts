import { Criterion, CRITERIA } from "../ai/schemas/common";
import { computeInterviewScore } from "./interview-score";

/**
 * Construcción del bloque `{{interview_context}}` que recibe
 * `prompts/score-candidate.md` (BLUEPRINT §13): lo que el candidato demostró
 * en la entrevista, para CONTRASTARLO con lo que promete el CV.
 *
 * Módulo PURO: no toca base de datos ni contenedor.
 *
 * PRIVACIDAD (§17): este texto contiene notas del evaluador, que son dato
 * privado. Viaja únicamente al modelo LOCAL, jamás a logs ni a la respuesta
 * HTTP (el LlmClient no loguea contenido de prompts).
 */

/** Etiquetas en español de los criterios (§06). */
const CRITERION_LABELS: Record<Criterion, string> = {
    adaptability: "Adaptabilidad",
    fundamentals: "Fundamentos",
    depth: "Profundidad",
    production: "Producción",
    stack: "Stack",
};

/**
 * PRESUPUESTO DE TOKENS (§18). El contexto puede llegar a 20 preguntas
 * (límite §16) y las notas del evaluador son texto libre de hasta 10.000
 * caracteres cada una: sin recorte, el prompt reventaría el contexto del
 * modelo. Criterio de truncado, del dato más prescindible al menos:
 *
 * 1. Notas del evaluador: 400 caracteres por pregunta (es lo más largo y lo
 *    más redundante; lo esencial suele estar al principio).
 * 2. Respuesta ideal: 300 caracteres (solo sirve de referencia de contraste).
 * 3. Enunciado de la pregunta: 300 caracteres.
 *
 * Cota superior del bloque: 20 × ~1.100 caracteres ≈ 22.000 caracteres
 * ≈ 6.100 tokens, que caben de sobra en el presupuesto de entrada.
 * Todo recorte se marca con "…" para que el modelo sepa que hay más texto.
 */
export const MAX_ANSWER_NOTES_CHARS = 400;
export const MAX_IDEAL_ANSWER_CHARS = 300;
export const MAX_QUESTION_CHARS = 300;

/**
 * Texto que se envía cuando el candidato NO tiene ninguna respuesta puntuada.
 * El prompt sigue siendo válido y el análisis se comporta como antes de §13
 * (solo CV, todos los `verdict` a `not_assessed`).
 */
export const NO_INTERVIEW_CONTEXT =
    "(Sin respuestas de entrevista puntuadas: no hay nada que contrastar. " +
    "Puntúa solo con el CV y responde `not_assessed` en los cinco `verdict`.)";

/** Pregunta con su respuesta evaluada, tal y como la necesita el contraste. */
export interface InterviewContextQuestion {
    criterion: string;
    question: string;
    idealAnswer: string | null;
    /** Nota 1-10 de la respuesta; las no puntuadas se ignoran. */
    answerScore: number | null;
    answerNotes: string | null;
}

/** Bloque de contexto listo para el prompt. */
export interface InterviewContext {
    /** Texto markdown a sustituir en `{{interview_context}}`. */
    text: string;
    /** Preguntas con nota que se incluyeron (0 ⇒ texto neutro). */
    answeredCount: number;
}

/** Recorta a `max` caracteres marcando el corte con "…". */
function truncate(value: string, max: number): string {
    const clean = value.trim();
    return clean.length <= max ? clean : `${clean.slice(0, max)}…`;
}

function isValidCriterion(criterion: string): criterion is Criterion {
    return (CRITERIA as readonly string[]).includes(criterion);
}

/**
 * Construye el contexto de entrevista agrupado por criterio: media del
 * criterio y, por pregunta, enunciado, respuesta ideal, nota 1-10 y notas del
 * evaluador. Solo entran las preguntas CON nota (una pregunta sin puntuar no
 * es evidencia de nada).
 */
export function buildInterviewContext(
    questions: InterviewContextQuestion[],
): InterviewContext {
    const answered = questions.filter(
        (question) =>
            question.answerScore !== null && isValidCriterion(question.criterion),
    );
    if (answered.length === 0) {
        return { text: NO_INTERVIEW_CONTEXT, answeredCount: 0 };
    }

    const interview = computeInterviewScore(
        answered.map((question) => ({
            criterion: question.criterion,
            answerScore: question.answerScore,
        })),
    );

    const lines: string[] = [
        `Respuestas puntuadas: ${answered.length} de ${questions.length} preguntas. ` +
            `Nota global de entrevista: ${interview.overall ?? "—"}/10.`,
        "",
    ];

    for (const criterion of CRITERIA) {
        const ofCriterion = answered.filter(
            (question) => question.criterion === criterion,
        );
        if (ofCriterion.length === 0) {
            continue;
        }
        const average = interview.byCriterion[criterion];
        lines.push(
            `### ${CRITERION_LABELS[criterion]} (\`${criterion}\`) — nota media ${average?.average ?? "—"}/10 ` +
                `sobre ${ofCriterion.length} respuesta(s)`,
        );
        lines.push("");
        for (const question of ofCriterion) {
            lines.push(
                `- Pregunta: ${truncate(question.question, MAX_QUESTION_CHARS)}`,
            );
            if (question.idealAnswer) {
                lines.push(
                    `  - Respuesta ideal esperada: ${truncate(question.idealAnswer, MAX_IDEAL_ANSWER_CHARS)}`,
                );
            }
            lines.push(`  - Nota del evaluador: ${question.answerScore}/10`);
            if (question.answerNotes) {
                lines.push(
                    `  - Notas del evaluador sobre lo que respondió: ${truncate(question.answerNotes, MAX_ANSWER_NOTES_CHARS)}`,
                );
            }
        }
        lines.push("");
    }

    return { text: lines.join("\n").trimEnd(), answeredCount: answered.length };
}
