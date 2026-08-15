import { describe, expect, it } from "vitest";
import {
    buildCompareCandidatesSchemas,
    candidateRef,
    MAX_CRITERION_ANALYSIS_LENGTH,
    MAX_TIES,
} from "../src/ai/schemas/compare-candidates";
import { CRITERIA } from "../src/ai/schemas/common";
import {
    buildCandidatesJson,
    ComparisonCandidateSource,
    MAX_DOUBTS,
    MAX_EVIDENCE_CHARS,
    MAX_EVIDENCE_PER_CRITERION,
    MAX_RATIONALE_CHARS,
    MAX_SUMMARY_CHARS,
    toComparisonCandidatePayload,
    truncate,
} from "../src/comparison/comparison-payload";
import {
    MIN_COMPARISON_CANDIDATES,
    parseComparisonInput,
} from "../src/comparison/comparison.dto";
import { AppError } from "../src/shared/errors";
import { newId } from "../src/shared/ids";
import { MAX_COMPARISON_CANDIDATES } from "../src/shared/limits";

/**
 * Piezas PURAS del dominio Comparison: el `{{candidates_json}}` que se envía
 * al modelo, el schema de salida construido por petición y la validación del
 * cuerpo de POST /comparison. Sin base de datos ni red.
 */

function source(
    overrides: Partial<ComparisonCandidateSource> = {},
): ComparisonCandidateSource {
    return {
        ref: "C1",
        name: "Ana Ejemplo",
        professionalSummary: "Backend con transiciones demostradas.",
        technologyTransitions: ["Java → TypeScript"],
        scores: {
            adaptability: 4,
            fundamentals: 3,
            depth: 3.5,
            production: 2,
            stack: 4,
        },
        cvScore: 3.4,
        overallScore: 3.4,
        provisional: true,
        confidence: 0.7,
        interviewScore: null,
        interviewByCriterion: {
            adaptability: null,
            fundamentals: null,
            depth: null,
            production: null,
            stack: null,
        },
        verdicts: {
            adaptability: "not_assessed",
            fundamentals: "not_assessed",
            depth: "not_assessed",
            production: "not_assessed",
            stack: "not_assessed",
        },
        rationales: { adaptability: "Migró un monolito." },
        evidence: {
            adaptability: [
                { text: "Lideró la migración a serverless.", type: "explicit" },
            ],
        },
        doubts: ["Validar profundidad."],
        ...overrides,
    };
}

describe("comparison-payload: {{candidates_json}}", () => {
    it("candidateRef numera desde C1", () => {
        expect(candidateRef(0)).toBe("C1");
        expect(candidateRef(4)).toBe("C5");
    });

    it("truncate recorta marcando el corte con '…' y respeta el máximo", () => {
        expect(truncate("corto", 10)).toBe("corto");
        const cut = truncate("x".repeat(50), 10);
        expect(cut).toHaveLength(10);
        expect(cut.endsWith("…")).toBe(true);
    });

    it("proyecta ref, nombre, resumen, scores, veredictos, entrevista, evidencias con tipo y dudas", () => {
        const payload = toComparisonCandidatePayload(
            source({
                interviewScore: 7.5,
                provisional: false,
                overallScore: 3.6,
                interviewByCriterion: {
                    adaptability: { average: 8, answered: 2 },
                    fundamentals: null,
                    depth: null,
                    production: null,
                    stack: null,
                },
                verdicts: {
                    adaptability: "confirmed",
                    fundamentals: "not_assessed",
                    depth: "not_assessed",
                    production: "not_assessed",
                    stack: "not_assessed",
                },
            }),
        );

        expect(payload).toMatchObject({
            ref: "C1",
            nombre: "Ana Ejemplo",
            resumen_profesional: "Backend con transiciones demostradas.",
            transiciones_tecnologicas: ["Java → TypeScript"],
            score_cv: 3.4,
            score_final: 3.6,
            score_final_provisional: false,
            confianza_analisis: 0.7,
            nota_entrevista_global: 7.5,
            dudas_pendientes: ["Validar profundidad."],
        });
        const criterios = payload.criterios as Record<string, unknown>;
        expect(Object.keys(criterios)).toEqual([...CRITERIA]);
        expect(criterios.adaptability).toEqual({
            puntuacion: 4,
            veredicto_entrevista: "confirmed",
            nota_entrevista: 8,
            justificacion: "Migró un monolito.",
            evidencias: [
                { texto: "Lideró la migración a serverless.", tipo: "explicit" },
            ],
        });
        // Un criterio sin análisis textual: nulos y lista vacía, nunca ausente.
        expect(criterios.stack).toEqual({
            puntuacion: 4,
            veredicto_entrevista: "not_assessed",
            nota_entrevista: null,
            justificacion: null,
            evidencias: [],
        });
    });

    it("recorta resumen, rationale, evidencias (número y longitud) y dudas al presupuesto", () => {
        const payload = toComparisonCandidatePayload(
            source({
                professionalSummary: "s".repeat(5_000),
                rationales: { depth: "r".repeat(1_000) },
                evidence: {
                    depth: Array.from({ length: 8 }, (_, i) => ({
                        text: `${i}`.padEnd(400, "e"),
                        type: "inferred" as const,
                    })),
                },
                doubts: Array.from({ length: 12 }, (_, i) => `duda ${i}`),
            }),
        );

        expect((payload.resumen_profesional as string).length).toBe(
            MAX_SUMMARY_CHARS,
        );
        const depth = (payload.criterios as Record<string, { justificacion: string; evidencias: Array<{ texto: string }> }>).depth;
        expect(depth.justificacion.length).toBe(MAX_RATIONALE_CHARS);
        expect(depth.evidencias).toHaveLength(MAX_EVIDENCE_PER_CRITERION);
        expect(depth.evidencias[0].texto.length).toBe(MAX_EVIDENCE_CHARS);
        expect(payload.dudas_pendientes).toHaveLength(MAX_DOUBTS);
    });

    it("buildCandidatesJson serializa la lista completa en orden y parsea como JSON", () => {
        const json = buildCandidatesJson([
            source(),
            source({ ref: "C2", name: "Luis Prueba" }),
        ]);
        const parsed = JSON.parse(json) as Array<{ ref: string; nombre: string }>;
        expect(parsed.map((c) => c.ref)).toEqual(["C1", "C2"]);
        expect(parsed[1].nombre).toBe("Luis Prueba");
    });

    it("cinco candidatos con los máximos de recorte caben en el presupuesto de contexto (~20.000 tokens)", () => {
        const heavy = Array.from({ length: MAX_COMPARISON_CANDIDATES }, (_, i) =>
            source({
                ref: candidateRef(i),
                professionalSummary: "s".repeat(1_500),
                technologyTransitions: Array.from({ length: 10 }, () =>
                    "t".repeat(300),
                ),
                rationales: Object.fromEntries(
                    CRITERIA.map((c) => [c, "r".repeat(400)]),
                ),
                evidence: Object.fromEntries(
                    CRITERIA.map((c) => [
                        c,
                        Array.from({ length: 8 }, () => ({
                            text: "e".repeat(300),
                            type: "explicit" as const,
                        })),
                    ]),
                ),
                doubts: Array.from({ length: 10 }, () => "d".repeat(300)),
            }),
        );
        const json = buildCandidatesJson(heavy);
        // ~3,6 caracteres por token (ai/llm-client.ts); margen holgado bajo
        // los ~20.000 tokens de entrada disponibles.
        expect(Math.ceil(json.length / 3.6)).toBeLessThan(14_000);
    });
});

describe("ai/schemas/compare-candidates: schema por petición", () => {
    const refs = ["C1", "C2", "C3"];

    function validOutput() {
        return {
            criteria: Object.fromEntries(
                CRITERIA.map((c) => [c, { leaders: ["C1"], analysis: "A" }]),
            ),
            evidence_quality: "E",
            profiles: "P",
            ties: [{ candidates: ["C2", "C3"], what_would_separate: "S" }],
            open_questions: ["Q"],
            summary: "R",
        };
    }

    it("el JSON Schema restringe leaders y ties.candidates al enum de referencias", () => {
        const { jsonSchema } = buildCompareCandidatesSchemas(refs);
        const properties = jsonSchema.properties as Record<string, unknown>;
        const criteria = properties.criteria as {
            required: string[];
            properties: Record<string, { properties: { leaders: unknown } }>;
        };
        expect(criteria.required).toEqual([...CRITERIA]);
        expect(criteria.properties.depth.properties.leaders).toEqual({
            type: "array",
            maxItems: 3,
            items: { type: "string", enum: refs },
        });
        const ties = properties.ties as {
            maxItems: number;
            items: { properties: { candidates: { minItems: number; items: unknown } } };
        };
        expect(ties.maxItems).toBe(MAX_TIES);
        expect(ties.items.properties.candidates.minItems).toBe(2);
        expect(ties.items.properties.candidates.items).toEqual({
            type: "string",
            enum: refs,
        });
        expect(jsonSchema.additionalProperties).toBe(false);
    });

    it("zod acepta una salida válida y deduplica referencias repetidas", () => {
        const { zodSchema } = buildCompareCandidatesSchemas(refs);
        const output = validOutput();
        output.criteria.stack.leaders = ["C1", "C1", "C2"];
        output.ties.push({
            candidates: ["C1", "C1"],
            what_would_separate: "nada",
        });
        const parsed = zodSchema.parse(output);
        expect(parsed.criteria.stack.leaders).toEqual(["C1", "C2"]);
        // El "empate" C1-C1 se queda con un solo candidato y se descarta.
        expect(parsed.ties).toEqual([
            { candidates: ["C2", "C3"], what_would_separate: "S" },
        ]);
    });

    it("zod rechaza referencias fuera del enum, textos demasiado largos y claves extra", () => {
        const { zodSchema } = buildCompareCandidatesSchemas(refs);
        const stranger = validOutput();
        stranger.criteria.depth.leaders = ["C9"];
        expect(() => zodSchema.parse(stranger)).toThrow();

        const long = validOutput();
        long.criteria.depth.analysis = "x".repeat(
            MAX_CRITERION_ANALYSIS_LENGTH + 1,
        );
        expect(() => zodSchema.parse(long)).toThrow();

        const extra = { ...validOutput(), score: 5 };
        expect(() => zodSchema.parse(extra)).toThrow();
    });

    it("exige al menos dos referencias distintas", () => {
        expect(() => buildCompareCandidatesSchemas(["C1"])).toThrow();
        expect(() => buildCompareCandidatesSchemas(["C1", "C1"])).toThrow();
    });
});

describe("parseComparisonInput", () => {
    const ids = () =>
        Array.from({ length: MAX_COMPARISON_CANDIDATES }, () => newId());

    it("acepta entre 2 y MAX_COMPARISON_CANDIDATES ids únicos, en orden", () => {
        const two = ids().slice(0, MIN_COMPARISON_CANDIDATES);
        expect(parseComparisonInput({ candidateIds: two })).toEqual({
            candidateIds: two,
        });
        const max = ids();
        expect(parseComparisonInput({ candidateIds: max }).candidateIds).toEqual(
            max,
        );
    });

    it.each([
        ["cuerpo no objeto", "nope"],
        ["cuerpo null", null],
        ["sin candidateIds", {}],
        ["candidateIds no lista", { candidateIds: "a,b" }],
        ["un solo id", { candidateIds: [newId()] }],
        ["más del máximo", { candidateIds: [...ids(), newId()] }],
        ["id inválido", { candidateIds: [newId(), "no-es-uuid"] }],
        ["clave desconocida", { candidateIds: [newId(), newId()], extra: 1 }],
    ])("rechaza con INVALID_INPUT: %s", (_label, body) => {
        expect(() => parseComparisonInput(body)).toThrow(AppError);
        try {
            parseComparisonInput(body);
        } catch (error) {
            expect((error as AppError).code).toBe("INVALID_INPUT");
        }
    });

    it("rechaza ids repetidos sin reflejarlos en el mensaje", () => {
        const id = newId();
        try {
            parseComparisonInput({ candidateIds: [id, id] });
            expect.unreachable();
        } catch (error) {
            expect((error as AppError).code).toBe("INVALID_INPUT");
            expect((error as AppError).message).not.toContain(id);
        }
    });
});
