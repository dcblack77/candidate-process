import { describe, expect, it } from "vitest";
import {
    buildInterviewContext,
    InterviewContextQuestion,
    MAX_ANSWER_NOTES_CHARS,
    MAX_IDEAL_ANSWER_CHARS,
    MAX_QUESTION_CHARS,
    NO_INTERVIEW_CONTEXT,
} from "../src/scoring/interview-context";

/**
 * Unit de scoring/interview-context.ts (BLUEPRINT §13 y §18): el bloque de
 * evidencia de entrevista que se inyecta en score-candidate, incluido el
 * truncado que protege el presupuesto de tokens.
 */

function question(
    overrides: Partial<InterviewContextQuestion> = {},
): InterviewContextQuestion {
    return {
        criterion: "adaptability",
        question: "¿Cuéntame una transición?",
        idealAnswer: "Una transición concreta con entregables.",
        answerScore: 7,
        answerNotes: "Respondió con ejemplos.",
        ...overrides,
    };
}

describe("buildInterviewContext", () => {
    it("sin preguntas devuelve el texto neutro", () => {
        expect(buildInterviewContext([])).toEqual({
            text: NO_INTERVIEW_CONTEXT,
            answeredCount: 0,
        });
    });

    it("una pregunta sin nota no es evidencia: texto neutro", () => {
        const result = buildInterviewContext([
            question({ answerScore: null, question: "NO-DEBE-APARECER" }),
        ]);
        expect(result.answeredCount).toBe(0);
        expect(result.text).toBe(NO_INTERVIEW_CONTEXT);
        expect(result.text).not.toContain("NO-DEBE-APARECER");
    });

    it("agrupa por criterio con media, nota y notas del evaluador", () => {
        const result = buildInterviewContext([
            question({ criterion: "adaptability", answerScore: 8 }),
            question({ criterion: "adaptability", answerScore: 6 }),
            question({
                criterion: "stack",
                answerScore: 2,
                question: "¿AWS?",
                answerNotes: "Nunca lo usó.",
            }),
        ]);

        expect(result.answeredCount).toBe(3);
        expect(result.text).toContain("Respuestas puntuadas: 3 de 3 preguntas");
        expect(result.text).toContain(
            "Adaptabilidad (`adaptability`) — nota media 7/10 sobre 2 respuesta(s)",
        );
        expect(result.text).toContain(
            "Stack (`stack`) — nota media 2/10 sobre 1 respuesta(s)",
        );
        expect(result.text).toContain("Nota del evaluador: 2/10");
        expect(result.text).toContain("Nunca lo usó.");
        // Criterios sin respuestas puntuadas no aparecen.
        expect(result.text).not.toContain("Profundidad");
    });

    it("ignora criterios desconocidos (defensivo, aunque haya CHECK en DB)", () => {
        const result = buildInterviewContext([
            question({ criterion: "inventado", question: "NO-DEBE-APARECER" }),
        ]);
        expect(result.answeredCount).toBe(0);
        expect(result.text).toBe(NO_INTERVIEW_CONTEXT);
    });

    it("trunca pregunta, respuesta ideal y notas al presupuesto documentado", () => {
        const result = buildInterviewContext([
            question({
                question: "P".repeat(MAX_QUESTION_CHARS + 50),
                idealAnswer: "I".repeat(MAX_IDEAL_ANSWER_CHARS + 50),
                answerNotes: "N".repeat(MAX_ANSWER_NOTES_CHARS + 5_000),
            }),
        ]);

        expect(result.text).toContain(`${"P".repeat(MAX_QUESTION_CHARS)}…`);
        expect(result.text).not.toContain("P".repeat(MAX_QUESTION_CHARS + 1));
        expect(result.text).toContain(`${"I".repeat(MAX_IDEAL_ANSWER_CHARS)}…`);
        expect(result.text).not.toContain(
            "I".repeat(MAX_IDEAL_ANSWER_CHARS + 1),
        );
        expect(result.text).toContain(
            `${"N".repeat(MAX_ANSWER_NOTES_CHARS)}…`,
        );
        expect(result.text).not.toContain(
            "N".repeat(MAX_ANSWER_NOTES_CHARS + 1),
        );
    });

    it("20 preguntas con notas máximas siguen cabiendo holgadamente", () => {
        const many = Array.from({ length: 20 }, () =>
            question({
                question: "P".repeat(1_000),
                idealAnswer: "I".repeat(1_000),
                answerNotes: "N".repeat(10_000),
            }),
        );
        // Cota documentada en el módulo: ~22.000 caracteres (~6.100 tokens).
        expect(buildInterviewContext(many).text.length).toBeLessThan(24_000);
    });
});
