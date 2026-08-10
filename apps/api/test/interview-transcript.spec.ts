import { describe, expect, it } from "vitest";
import {
    candidateText,
    formatTimestamp,
    isHallucination,
    mergeTracks,
    renderDialogue,
    TranscriptTrack,
} from "../src/interview/transcript";

/**
 * Fusión y limpieza de las pistas de la entrevista (§24).
 *
 * Lo que se fija aquí es la garantía de la que depende todo lo demás: quién
 * dijo cada cosa. Si la atribución de hablante se rompe, el modelo acaba
 * dando por demostrado algo que en realidad preguntó el entrevistador.
 */

function track(
    speaker: "candidato" | "sala",
    segments: Array<{
        start: number;
        end: number;
        text: string;
        noSpeechProb?: number;
    }>,
): TranscriptTrack {
    return { speaker, segments };
}

describe("mergeTracks", () => {
    it("intercala las dos pistas por marca de tiempo y las etiqueta", () => {
        const merged = mergeTracks([
            track("candidato", [
                { start: 10, end: 14, text: "partimos el dominio por contexto" },
                { start: 20, end: 24, text: "y medimos la latencia" },
            ]),
            track("sala", [
                { start: 15, end: 18, text: "¿y cómo lo comprobaste?" },
            ]),
        ]);

        expect(merged.map((s) => [s.speaker, s.startSec])).toEqual([
            ["candidato", 10],
            ["sala", 15],
            ["candidato", 20],
        ]);
    });

    it("a igual instante pone primero al candidato (determinista)", () => {
        const merged = mergeTracks([
            track("sala", [{ start: 5, end: 6, text: "hola" }]),
            track("candidato", [{ start: 5, end: 6, text: "buenas" }]),
        ]);
        expect(merged[0].speaker).toBe("candidato");
    });

    it("descarta los tramos que whisper marca como silencio", () => {
        const merged = mergeTracks([
            track("candidato", [
                { start: 0, end: 2, text: "algo real", noSpeechProb: 0.1 },
                { start: 3, end: 5, text: "ruido", noSpeechProb: 0.95 },
            ]),
        ]);
        expect(merged).toHaveLength(1);
        expect(merged[0].text).toBe("algo real");
    });

    it("tolera segmentos sin no_speech_prob (el servidor puede no enviarlo)", () => {
        const merged = mergeTracks([
            track("candidato", [{ start: 0, end: 2, text: "sin ese campo" }]),
        ]);
        expect(merged).toHaveLength(1);
    });

    it("normaliza los espacios del texto", () => {
        const merged = mergeTracks([
            track("candidato", [
                { start: 0, end: 2, text: "  con   espacios \n raros " },
            ]),
        ]);
        expect(merged[0].text).toBe("con espacios raros");
    });
});

describe("isHallucination", () => {
    /**
     * whisper inventa estas frases sobre silencio: vienen del corpus de
     * subtítulos con el que se entrenó. Colarlas sería dar por dicho algo que
     * nadie dijo, y es munición directa para un falso positivo.
     */
    it.each([
        "Subtítulos realizados por la comunidad de Amara.org",
        "subtitulado por Amara.org",
        "¡Gracias por ver el vídeo!",
        "¡Suscríbete!",
        "[Música]",
        "(Aplausos)",
        "Gracias.",
        "   ",
    ])("descarta %j", (text) => {
        expect(isHallucination(text)).toBe(true);
    });

    it.each([
        "gracias por ver el pipeline, lo montamos con CodePipeline",
        "particionamos el dominio por bounded context",
        "la música del equipo era buena pero el deploy fallaba",
    ])("conserva habla real: %j", (text) => {
        expect(isHallucination(text)).toBe(false);
    });

    it("filtra las alucinaciones al fusionar, no solo en la función suelta", () => {
        const merged = mergeTracks([
            track("candidato", [
                { start: 0, end: 2, text: "Subtítulos realizados por Amara.org" },
                { start: 3, end: 6, text: "usamos DynamoDB con índices" },
            ]),
        ]);
        expect(merged).toHaveLength(1);
        expect(merged[0].text).toContain("DynamoDB");
    });
});

describe("renderDialogue", () => {
    it("marca hablante y minuto en cada línea", () => {
        const merged = mergeTracks([
            track("candidato", [{ start: 751, end: 760, text: "lo migramos" }]),
            track("sala", [{ start: 768, end: 772, text: "¿cuánto tardó?" }]),
        ]);
        expect(renderDialogue(merged)).toBe(
            "[12:31] CANDIDATO: lo migramos\n[12:48] SALA: ¿cuánto tardó?",
        );
    });
});

describe("candidateText", () => {
    it("deja fuera lo que dijo la sala", () => {
        const merged = mergeTracks([
            track("candidato", [{ start: 0, end: 2, text: "yo lo hice así" }]),
            track("sala", [{ start: 3, end: 5, text: "¿y usaste Kafka?" }]),
        ]);
        const text = candidateText(merged);
        expect(text).toContain("yo lo hice así");
        // Si esto se colara, una pregunta del entrevistador podría acabar
        // citada como prueba de lo que demostró el candidato.
        expect(text).not.toContain("Kafka");
    });
});

describe("formatTimestamp", () => {
    it.each([
        [0, "00:00"],
        [59, "00:59"],
        [60, "01:00"],
        [751, "12:31"],
        [3671, "61:11"],
    ])("%i s → %s", (seconds, expected) => {
        expect(formatTimestamp(seconds)).toBe(expected);
    });

    it("no revienta con valores negativos", () => {
        expect(formatTimestamp(-5)).toBe("00:00");
    });
});
