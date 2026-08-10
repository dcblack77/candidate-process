import { describe, expect, it } from "vitest";
import { AssessCoverageResult } from "../src/ai/schemas/assess-coverage";
import {
    buildCandidateIndex,
    locateQuote,
    verifyAssessment,
} from "../src/interview/quote-verifier";
import { TranscriptSegment } from "../src/interview/transcript";

/**
 * Verificación de citas y degradación de cobertura (§24).
 *
 * Este spec es el que sostiene la fiabilidad de toda la funcionalidad: un
 * modelo de 2B afirma "abordado_demostrado" con una cita adornada sin
 * despeinarse, y lo único que lo impide es lo que se fija aquí.
 */

const SEGMENTS: TranscriptSegment[] = [
    {
        startSec: 100,
        endSec: 110,
        speaker: "sala",
        text: "¿Y cómo particionaste el dominio en la migración?",
    },
    {
        startSec: 111,
        endSec: 125,
        speaker: "candidato",
        text: "Partimos por bounded context, separando pagos de catálogo, porque los ciclos de despliegue no tenían nada que ver",
    },
    {
        startSec: 126,
        endSec: 138,
        speaker: "candidato",
        text: "Medimos la latencia p99 antes y después con CloudWatch y bajó de 800 a 210 milisegundos",
    },
];

/** Resultado crudo del modelo, al que se le va rompiendo un campo cada vez. */
function rawAssessment(
    overrides: Partial<AssessCoverageResult> = {},
): AssessCoverageResult {
    return {
        coverage: "abordado_demostrado",
        proposed_score: 8,
        proposed_notes: "Explica la partición y la valida con métricas.",
        evidence: [
            {
                quote: "Partimos por bounded context, separando pagos de catálogo, porque los ciclos de despliegue no tenían nada que ver",
            },
            {
                quote: "Medimos la latencia p99 antes y después con CloudWatch y bajó de 800 a 210 milisegundos",
            },
        ],
        confidence: 0.8,
        ...overrides,
    };
}

describe("locateQuote", () => {
    const index = buildCandidateIndex(SEGMENTS);

    it("localiza una cita literal y devuelve su tramo temporal", () => {
        const located = locateQuote("separando pagos de catálogo", index);
        expect(located).toMatchObject({ startSec: 111, endSec: 125 });
    });

    it("es insensible a mayúsculas, acentos y puntuación", () => {
        expect(
            locateQuote("SEPARANDO PAGOS DE CATALOGO!!", index),
        ).not.toBeNull();
    });

    it("tolera que el modelo corte el final de la cita", () => {
        expect(
            locateQuote(
                "Medimos la latencia p99 antes y después con CloudWatch y bajó de 800 a 210 milisegund",
                index,
            ),
        ).not.toBeNull();
    });

    it("encuentra una cita que cruza dos segmentos", () => {
        const located = locateQuote(
            "no tenían nada que ver Medimos la latencia p99",
            index,
        );
        expect(located).toMatchObject({ startSec: 111, endSec: 138 });
    });

    it("NO localiza lo que dijo la sala: preguntar no es demostrar", () => {
        expect(
            locateQuote("cómo particionaste el dominio en la migración", index),
        ).toBeNull();
    });

    it("no localiza una cita inventada", () => {
        expect(
            locateQuote("lideré un equipo de quince personas", index),
        ).toBeNull();
    });

    it("una cita vacía no vale", () => {
        expect(locateQuote("   ", index)).toBeNull();
    });

    it("sin líneas del candidato no hay nada que localizar", () => {
        const soloSala = buildCandidateIndex([SEGMENTS[0]]);
        expect(locateQuote("cómo particionaste", soloSala)).toBeNull();
    });
});

describe("verifyAssessment", () => {
    it("mantiene el nivel con citas verificadas de longitud suficiente", () => {
        // 200 caracteres verificados, por encima del suelo de 180 que exige
        // `abordado_demostrado`.
        const verified = verifyAssessment(rawAssessment(), SEGMENTS);
        expect(verified.coverage).toBe("abordado_demostrado");
        expect(verified.proposedScore).toBe(8);
        expect(verified.evidence).toHaveLength(2);
        expect(verified.demoted).toBe(false);
    });

    it("descarta las citas que el candidato nunca dijo", () => {
        const verified = verifyAssessment(
            rawAssessment({
                evidence: [
                    { quote: "Partimos por bounded context, separando pagos de catálogo, porque los ciclos de despliegue no tenían nada que ver" },
                    { quote: "también monté todo el sistema de facturación yo solo" },
                ],
            }),
            SEGMENTS,
        );
        expect(verified.evidence).toHaveLength(1);
        expect(verified.evidence[0].quote).toContain("bounded context");
    });

    it("sin ninguna cita verificada, abordado_* baja a mencionado y la nota se anula", () => {
        const verified = verifyAssessment(
            rawAssessment({
                evidence: [{ quote: "esto no lo dijo nadie en la entrevista" }],
            }),
            SEGMENTS,
        );
        expect(verified.coverage).toBe("mencionado");
        expect(verified.proposedScore).toBeNull();
        expect(verified.demoted).toBe(true);
    });

    it("con el array de citas vacío pasa exactamente lo mismo", () => {
        const verified = verifyAssessment(
            rawAssessment({ evidence: [] }),
            SEGMENTS,
        );
        expect(verified.coverage).toBe("mencionado");
        expect(verified.proposedScore).toBeNull();
    });

    it("una cita corta no sostiene «demostrado»: baja a parcial", () => {
        const verified = verifyAssessment(
            rawAssessment({
                evidence: [
                    {
                        quote: "Medimos la latencia p99 antes y después con CloudWatch",
                    },
                ],
            }),
            SEGMENTS,
        );
        // 54 caracteres: por debajo del suelo de 180 de «demostrado». No
        // llega tampoco a los 60 de «parcial», así que cae hasta mencionado.
        expect(verified.coverage).toBe("mencionado");
        expect(verified.proposedScore).toBeNull();
        expect(verified.demoted).toBe(true);
    });

    it("una cita de tamaño medio sostiene «parcial» pero no «demostrado»", () => {
        const verified = verifyAssessment(
            rawAssessment({
                evidence: [
                    {
                        quote: "Medimos la latencia p99 antes y después con CloudWatch y bajó de 800 a 210 milisegundos",
                    },
                ],
            }),
            SEGMENTS,
        );
        // 87 caracteres: pasa el suelo de 60 de «parcial», no el de 180.
        expect(verified.coverage).toBe("abordado_parcial");
        expect(verified.proposedScore).toBe(8);
        expect(verified.demoted).toBe(true);
    });

    it("una cita muy corta no sostiene ni «parcial»", () => {
        const verified = verifyAssessment(
            rawAssessment({
                coverage: "abordado_parcial",
                evidence: [{ quote: "CloudWatch" }],
            }),
            SEGMENTS,
        );
        expect(verified.coverage).toBe("mencionado");
        expect(verified.proposedScore).toBeNull();
    });

    it("no_abordado y mencionado nunca llevan nota", () => {
        for (const coverage of ["no_abordado", "mencionado"] as const) {
            const verified = verifyAssessment(
                rawAssessment({ coverage, evidence: [] }),
                SEGMENTS,
            );
            expect(verified.coverage).toBe(coverage);
            expect(verified.proposedScore).toBeNull();
            expect(verified.demoted).toBe(false);
        }
    });

    it("una cita que en realidad dijo la SALA no cuenta como evidencia", () => {
        const verified = verifyAssessment(
            rawAssessment({
                evidence: [
                    { quote: "¿Y cómo particionaste el dominio en la migración?" },
                ],
            }),
            SEGMENTS,
        );
        expect(verified.evidence).toHaveLength(0);
        expect(verified.coverage).toBe("mencionado");
    });

    it("recorta a tres citas aunque el modelo mande más", () => {
        const verified = verifyAssessment(
            rawAssessment({
                evidence: [
                    { quote: "Partimos por bounded context" },
                    { quote: "separando pagos de catálogo" },
                    { quote: "Medimos la latencia p99" },
                    { quote: "bajó de 800 a 210 milisegundos" },
                ],
            }),
            SEGMENTS,
        );
        expect(verified.evidence.length).toBeLessThanOrEqual(3);
    });

    it("unas notas en blanco se guardan como null, no como cadena vacía", () => {
        const verified = verifyAssessment(
            rawAssessment({ proposed_notes: "   " }),
            SEGMENTS,
        );
        expect(verified.proposedNotes).toBeNull();
    });

    it("conserva la confianza que reportó el modelo", () => {
        const verified = verifyAssessment(
            rawAssessment({ confidence: 0.35 }),
            SEGMENTS,
        );
        expect(verified.confidence).toBe(0.35);
    });

    it("verifica contra los fragmentos enviados, no contra toda la entrevista", () => {
        // La cita es real, pero de un segmento que NO se le mandó al modelo
        // para esta pregunta: no puede servirle de prueba.
        const verified = verifyAssessment(
            rawAssessment({
                evidence: [{ quote: "bajó de 800 a 210 milisegundos" }],
            }),
            [SEGMENTS[0], SEGMENTS[1]],
        );
        expect(verified.evidence).toHaveLength(0);
    });
});
