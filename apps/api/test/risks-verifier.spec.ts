import { describe, expect, it } from "vitest";
import { DetectRisksResult } from "../src/ai/schemas/detect-risks";
import {
    buildSourceIndex,
    EXPLICIT_MATCH_THRESHOLD,
    groundingRatio,
    verifyRisks,
} from "../src/risks/risk-verifier";

/**
 * Verificador de evidencia de riesgos (módulo puro). Lo que se fija aquí es
 * la regla del proyecto: un riesgo "explícito" que el resumen no sostiene no
 * llega al evaluador como explícito. Se rebaja, no se inventa ni se borra.
 */

const SUMMARY = JSON.stringify({
    professional_summary:
        "Backend con 3 años en Java en el sector bancario y una migración reciente a Node.js.",
    experience: [
        {
            role: "Desarrollador backend",
            stack: ["Java", "Spring", "Oracle"],
            highlights: ["Mantenimiento de un core bancario"],
        },
        { role: "Desarrollador Node.js", stack: ["Node.js", "AWS Lambda"] },
    ],
});

function risk(
    evidence: { text: string; type: "explicit" | "inferred" },
    overrides: Partial<DetectRisksResult["risks"][number]> = {},
): DetectRisksResult["risks"][number] {
    return {
        category: "unproven_transition",
        criterion: "adaptability",
        severity: "medium",
        concern: "  Transición a Node.js sin entregables descritos.  ",
        evidence,
        interview_check: " ¿Qué entregó tras pasar a Node.js? ",
        ...overrides,
    };
}

describe("groundingRatio", () => {
    const index = buildSourceIndex(SUMMARY);

    it("una cita literal del resumen casa al 100 %", () => {
        expect(
            groundingRatio("migración reciente a Node.js", index),
        ).toBeGreaterThanOrEqual(EXPLICIT_MATCH_THRESHOLD);
    });

    it("tolera paráfrasis con morfología distinta (banca/bancario, tres/3 no)", () => {
        // "trabajado", "banca" comparten raíz con "trabajo"/"bancario"; "tres"
        // no está (el resumen dice "3"). Sigue por encima del umbral.
        expect(
            groundingRatio("trabajado años en banca con Java", index),
        ).toBeGreaterThanOrEqual(EXPLICIT_MATCH_THRESHOLD);
    });

    it("una afirmación que el resumen no contiene queda por debajo del umbral", () => {
        expect(
            groundingRatio(
                "lideró un equipo de doce personas en Kubernetes",
                index,
            ),
        ).toBeLessThan(EXPLICIT_MATCH_THRESHOLD);
    });

    it("sin términos significativos vale 0 (no sostiene nada)", () => {
        expect(groundingRatio("", index)).toBe(0);
        expect(groundingRatio("de la que", index)).toBe(0);
    });
});

describe("verifyRisks", () => {
    it("mantiene `explicit` cuando la evidencia está en el resumen y recorta espacios", () => {
        const { result, stats } = verifyRisks(
            {
                risks: [
                    risk({
                        text: " migración reciente a Node.js ",
                        type: "explicit",
                    }),
                ],
                gaps: [],
                confidence: 0.7,
            },
            [SUMMARY],
        );

        expect(result.risks[0].evidence).toEqual({
            text: "migración reciente a Node.js",
            type: "explicit",
        });
        expect(result.risks[0].concern).toBe(
            "Transición a Node.js sin entregables descritos.",
        );
        expect(result.risks[0].interview_check).toBe(
            "¿Qué entregó tras pasar a Node.js?",
        );
        expect(stats).toEqual({
            risks: 1,
            gaps: 0,
            explicit: 1,
            inferred: 0,
            downgradedToInferred: 0,
        });
    });

    it("rebaja a `inferred` un `explicit` que el resumen no sostiene, sin borrar el riesgo", () => {
        const { result, stats } = verifyRisks(
            {
                risks: [
                    risk({
                        text: "Lideró un equipo de doce personas en Kubernetes",
                        type: "explicit",
                    }),
                ],
                gaps: [],
                confidence: 0.5,
            },
            [SUMMARY],
        );

        expect(result.risks).toHaveLength(1);
        expect(result.risks[0].evidence.type).toBe("inferred");
        expect(stats.downgradedToInferred).toBe(1);
        expect(stats.explicit).toBe(0);
        expect(stats.inferred).toBe(1);
    });

    it("no toca los `inferred`: una ausencia no tiene por qué casar con el resumen", () => {
        const { result, stats } = verifyRisks(
            {
                risks: [
                    risk({
                        text: "No menciona operación ni incidentes en producción",
                        type: "inferred",
                    }),
                ],
                gaps: [],
                confidence: 0.5,
            },
            [SUMMARY],
        );

        expect(result.risks[0].evidence.type).toBe("inferred");
        expect(stats.downgradedToInferred).toBe(0);
    });

    it("el contexto del rol también es fuente válida de evidencia explícita", () => {
        const { stats } = verifyRisks(
            {
                risks: [
                    risk(
                        {
                            text: "el rol exige DynamoDB y Step Functions",
                            type: "explicit",
                        },
                        { category: "role_gap", criterion: "stack" },
                    ),
                ],
                gaps: [],
                confidence: 0.6,
            },
            [SUMMARY, "El equipo usa DynamoDB y Step Functions a diario."],
        );

        expect(stats.explicit).toBe(1);
        expect(stats.downgradedToInferred).toBe(0);
    });

    it("las lagunas se recortan y se cuentan pero no se verifican", () => {
        const { result, stats } = verifyRisks(
            {
                risks: [],
                gaps: [
                    {
                        criterion: "production",
                        missing: "  Si operó sistemas en producción.  ",
                        why_it_matters: " El rol tiene guardias. ",
                        interview_check: " Pide un incidente real que resolviera. ",
                    },
                ],
                confidence: 0.4,
            },
            [SUMMARY],
        );

        expect(result.gaps[0]).toEqual({
            criterion: "production",
            missing: "Si operó sistemas en producción.",
            why_it_matters: "El rol tiene guardias.",
            interview_check: "Pide un incidente real que resolviera.",
        });
        expect(stats).toMatchObject({ risks: 0, gaps: 1 });
    });

    it("una salida vacía es válida: cero riesgos, cero lagunas", () => {
        const { result, stats } = verifyRisks(
            { risks: [], gaps: [], confidence: 0.9 },
            [SUMMARY],
        );
        expect(result).toEqual({ risks: [], gaps: [], confidence: 0.9 });
        expect(stats).toEqual({
            risks: 0,
            gaps: 0,
            explicit: 0,
            inferred: 0,
            downgradedToInferred: 0,
        });
    });
});
