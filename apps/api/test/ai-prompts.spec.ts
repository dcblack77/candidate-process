import { writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PromptLoader } from "../src/ai/prompts";
import { createPromptsDir, makeAiEnv } from "./ai-helpers";

const TEMPLATE = `<!--
Prompt: saludo
Variables:
- {{name}}: nombre de la persona.
- {{role}}: rol evaluado.
-->

Hola {{name}}, bienvenido al proceso de {{ role }}.
Repetimos el nombre: {{name}}.`;

function makeLoader(dir: string): PromptLoader {
    return new PromptLoader(makeAiEnv({ PROMPTS_DIR: dir }));
}

describe("PromptLoader", () => {
    it("sustituye todas las variables, incluso repetidas y con espacios en las llaves", () => {
        const dir = createPromptsDir({ saludo: TEMPLATE });
        const rendered = makeLoader(dir).render("saludo", {
            name: "Ada",
            role: "Backend Dev",
        });

        expect(rendered).toContain(
            "Hola Ada, bienvenido al proceso de Backend Dev.",
        );
        expect(rendered).toContain("Repetimos el nombre: Ada.");
        expect(rendered).not.toContain("{{");
    });

    it("elimina el bloque de documentación (comentario HTML) antes de sustituir", () => {
        const dir = createPromptsDir({ saludo: TEMPLATE });
        const rendered = makeLoader(dir).render("saludo", {
            name: "Ada",
            role: "Dev",
        });

        // La documentación no viaja al modelo y sus {{...}} no duplican valores.
        expect(rendered).not.toContain("Variables:");
        expect(rendered).not.toContain("nombre de la persona");
        expect(rendered).not.toContain("<!--");
    });

    it("lanza si falta una variable, nombrándola sin filtrar contenido", () => {
        const dir = createPromptsDir({ saludo: TEMPLATE });
        const loader = makeLoader(dir);

        expect(() => loader.render("saludo", { name: "Ada" })).toThrowError(
            /\{\{role\}\}/,
        );
    });

    it("lanza si el archivo del prompt no existe", () => {
        const dir = createPromptsDir({});
        expect(() => makeLoader(dir).render("no-existe", {})).toThrowError(
            /no-existe/,
        );
    });

    it("ignora variables sobrantes no usadas por la plantilla", () => {
        const dir = createPromptsDir({ saludo: TEMPLATE });
        const rendered = makeLoader(dir).render("saludo", {
            name: "Ada",
            role: "Dev",
            extra: "ignorada",
        });
        expect(rendered).not.toContain("ignorada");
    });

    it("cachea la plantilla en memoria: cambios en disco no afectan a la instancia", () => {
        const dir = createPromptsDir({ saludo: "Hola {{name}}." });
        const loader = makeLoader(dir);
        expect(loader.render("saludo", { name: "Ada" })).toBe("Hola Ada.");

        writeFileSync(path.join(dir, "saludo.md"), "CAMBIADO {{name}}", "utf8");
        expect(loader.render("saludo", { name: "Ada" })).toBe("Hola Ada.");
    });
});

describe("prompts/ del repo", () => {
    // Los 5 prompts reales (BLUEPRINT §18) renderizan con sus variables documentadas.
    const REPO_PROMPTS = path.resolve(process.cwd(), "../../prompts");

    const cases: Array<[string, Record<string, string>]> = [
        [
            "summarize-cv",
            {
                cv_text: "CV_TEXTO",
                role_title: "ROL",
                role_context: "CONTEXTO",
            },
        ],
        [
            "score-candidate",
            {
                cv_summary_json: "{}",
                role_title: "ROL",
                role_context: "CONTEXTO",
                interview_context: "SIN ENTREVISTA",
            },
        ],
        [
            "generate-questions",
            {
                cv_summary_json: "{}",
                analysis_json: "{}",
                role_title: "ROL",
                role_context: "CONTEXTO",
                count: "8",
            },
        ],
        [
            "map-transcript-topics",
            {
                fragment: "[00:00] CANDIDATO: algo",
                fragment_range: "00:00–04:00",
                questions_index: "P1. ¿Qué migraste?",
                role_title: "ROL",
            },
        ],
        [
            "assess-question-coverage",
            {
                question: "¿Qué migraste?",
                criterion: "depth",
                dimension: "investigacion",
                ideal_answer: "IDEAL",
                positive_signals: "- una",
                warning_signals: "- otra",
                scoring_guidance: "1/3/5",
                transcript_excerpts: "[00:00] CANDIDATO: algo",
                role_title: "ROL",
                role_context: "CONTEXTO",
            },
        ],
        ["compare-candidates", { candidates_json: "[]", role_title: "ROL" }],
        [
            "detect-risks-and-gaps",
            {
                cv_summary_json: "{}",
                role_title: "ROL",
                role_context: "CONTEXTO",
            },
        ],
    ];

    it.each(cases)(
        "%s renderiza sin placeholders pendientes",
        (name, variables) => {
            const loader = makeLoader(REPO_PROMPTS);
            const rendered = loader.render(name, variables);
            expect(rendered.length).toBeGreaterThan(100);
            expect(rendered).not.toMatch(/\{\{\s*[a-zA-Z0-9_]+\s*\}\}/);
            expect(rendered).not.toContain("<!--");
        },
    );
});
