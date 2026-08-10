/**
 * Deja una sola pregunta por entrada (decisión del 2026-08-07).
 *
 * El prompt pide un único `?` por pregunta, pero `gemma-4-E2B` remata a menudo
 * con una segunda interrogación de cola ("… ¿Y qué métricas usaste?"). Eso es
 * justo lo que hacía los bloques largos e incómodos de leer en voz alta.
 *
 * Se corrige aquí y no rechazando la respuesta a propósito: rechazar dispara
 * los reintentos del LlmClient y, si el modelo insiste, acabaría en
 * LLM_UNAVAILABLE — perder las 8 preguntas por una coletilla sale mucho más
 * caro que recortarla. El evaluador siempre puede repreguntar en la entrevista.
 *
 * Solo actúa cuando hay MÁS DE UN `?`: una pregunta que continúa con una
 * indicación ("¿Qué hiciste? Ponme un ejemplo.") se deja intacta, igual que
 * las formulaciones sin interrogante ("Cuéntame una transición concreta.").
 */
export function trimToSingleQuestion(question: string): string {
    const first = question.indexOf("?");
    if (first === -1) {
        return question;
    }
    // ¿Hay otra interrogación después de la primera?
    if (!question.includes("?", first + 1)) {
        return question;
    }
    return question.slice(0, first + 1).trim();
}
