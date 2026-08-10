import { describe, expect, it } from "vitest";
import {
    buildQuestionQuery,
    normalizeText,
    rankByRelevance,
    tokenize,
} from "../src/interview/lexical-match";

/**
 * Ranking léxico (§24). Es la red de seguridad de la etapa de enrutado: si el
 * modelo de 2B no asigna ningún fragmento a una pregunta, esto elige el mejor
 * para evaluarla igualmente, en vez de dejarla sin evaluar en silencio.
 */

describe("normalizeText", () => {
    it("quita acentos, mayúsculas y puntuación", () => {
        expect(normalizeText("¿Cómo MIGRASTE, exactamente?")).toBe(
            "como migraste exactamente",
        );
    });

    it("pliega la eñe a n, pero IGUAL en los dos lados", () => {
        // No se conserva la eñe a propósito: whisper la transcribe de forma
        // poco fiable. Lo que garantiza el emparejamiento es que consulta y
        // documento se plieguen del mismo modo.
        expect(normalizeText("diseño")).toBe("diseno");
        expect(normalizeText("DISEÑO")).toBe(normalizeText("diseno"));
    });

    it("colapsa espacios", () => {
        expect(normalizeText("a   b\n\nc")).toBe("a b c");
    });
});

describe("tokenize", () => {
    it("descarta palabras vacías y muletillas", () => {
        expect(tokenize("bueno, entonces la cosa es que migramos")).toEqual([
            "migramos",
        ]);
    });

    it("descarta palabras de una o dos letras", () => {
        expect(tokenize("ir a la BD de AWS")).toEqual(["aws"]);
    });
});

describe("rankByRelevance", () => {
    const docs = [
        { index: 0, text: "hablamos del equipo y de las reuniones semanales" },
        {
            index: 1,
            text: "particionamos el dominio y medimos la latencia con CloudWatch",
        },
        { index: 2, text: "el proceso de contratación fue largo" },
    ];

    it("pone primero el fragmento que comparte vocabulario con la pregunta", () => {
        const ranked = rankByRelevance(
            "¿cómo particionaste el dominio y qué latencia mediste?",
            docs,
        );
        expect(ranked[0].index).toBe(1);
        expect(ranked[0].score).toBeGreaterThan(0);
    });

    it("premia los términos específicos sobre los que salen en todos", () => {
        const conRuido = [
            { index: 0, text: "migramos el sistema con cuidado" },
            { index: 1, text: "migramos el sistema usando DynamoDB e índices" },
        ];
        const ranked = rankByRelevance("migramos DynamoDB", conRuido);
        expect(ranked[0].index).toBe(1);
    });

    it("sin coincidencias devuelve todo a cero, no revienta", () => {
        const ranked = rankByRelevance("kubernetes helm istio", docs);
        expect(ranked.every((doc) => doc.score === 0)).toBe(true);
        expect(ranked).toHaveLength(3);
    });

    it("una consulta solo de palabras vacías no ordena nada", () => {
        const ranked = rankByRelevance("de la que el", docs);
        expect(ranked.map((d) => d.index)).toEqual([0, 1, 2]);
    });

    it("sin documentos devuelve lista vacía", () => {
        expect(rankByRelevance("lo que sea", [])).toEqual([]);
    });

    it("en empate gana el fragmento más temprano (determinista)", () => {
        const empatados = [
            { index: 3, text: "hablamos de lambda" },
            { index: 1, text: "hablamos de lambda" },
        ];
        const ranked = rankByRelevance("lambda", empatados);
        expect(ranked.map((d) => d.index)).toEqual([1, 3]);
    });

    it("es insensible a acentos: whisper no es fiable con tildes", () => {
        const ranked = rankByRelevance("migracion", [
            { index: 0, text: "el despliegue" },
            { index: 1, text: "la migración fue dura" },
        ]);
        expect(ranked[0].index).toBe(1);
    });
});

describe("buildQuestionQuery", () => {
    it("junta enunciado, respuesta ideal y señales positivas", () => {
        const query = buildQuestionQuery({
            question: "¿Cómo particionaste el dominio?",
            ideal_answer: "Nombra una decisión concreta",
            positive_signals: ["Cita una métrica", "Reconoce el error"],
        });
        expect(query).toContain("particionaste");
        expect(query).toContain("decisión");
        expect(query).toContain("métrica");
    });

    it("tolera respuesta ideal y señales ausentes", () => {
        expect(
            buildQuestionQuery({ question: "¿Qué migraste?" }).trim(),
        ).toBe("¿Qué migraste?");
    });
});
