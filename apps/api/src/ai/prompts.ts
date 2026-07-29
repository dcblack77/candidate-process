import { readFileSync } from "node:fs";
import path from "node:path";
import { inject, injectable } from "@expressots/core";
import { AppEnv, ENV } from "../env";

/**
 * Carga y renderizado de prompts versionados (BLUEPRINT §18 y §20).
 *
 * Los prompts viven como artefactos del repo en `PROMPTS_DIR/<name>.md`,
 * en español, con sus variables `{{...}}` documentadas en un comentario
 * HTML al inicio del archivo. Ese bloque de documentación se elimina antes
 * de sustituir variables, de modo que NUNCA viaja al modelo ni provoca
 * sustituciones duplicadas.
 */

/** Bloques de comentario HTML (documentación de variables del prompt). */
const HTML_COMMENT_RE = /<!--[\s\S]*?-->/g;

/** Placeholder `{{nombre_de_variable}}`. */
const PLACEHOLDER_RE = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

@injectable()
export class PromptLoader {
    /** Cache en memoria: nombre de prompt → plantilla ya sin comentarios. */
    private readonly cache = new Map<string, string>();

    constructor(@inject(ENV) private readonly env: AppEnv) {}

    /**
     * Devuelve la plantilla cruda (sin comentarios de documentación).
     * Lanza si el archivo no existe en PROMPTS_DIR.
     */
    load(name: string): string {
        const cached = this.cache.get(name);
        if (cached !== undefined) {
            return cached;
        }

        const filePath = path.join(this.env.PROMPTS_DIR, `${name}.md`);
        let raw: string;
        try {
            raw = readFileSync(filePath, "utf8");
        } catch {
            // Sin ruta absoluta en el mensaje: el nombre del prompt basta.
            throw new Error(
                `Prompt no encontrado: "${name}" (PROMPTS_DIR/${name}.md)`,
            );
        }

        const template = raw.replace(HTML_COMMENT_RE, "").trim();
        this.cache.set(name, template);
        return template;
    }

    /**
     * Renderiza `PROMPTS_DIR/<name>.md` sustituyendo cada `{{variable}}`.
     * Lanza si el archivo no existe o si queda algún placeholder sin valor.
     * Las variables sobrantes (no usadas por la plantilla) se ignoran.
     */
    render(name: string, variables: Record<string, string>): string {
        const template = this.load(name);

        const missing = new Set<string>();
        const rendered = template.replace(
            PLACEHOLDER_RE,
            (_match, varName: string) => {
                const value = variables[varName];
                if (value === undefined) {
                    missing.add(varName);
                    return "";
                }
                return value;
            },
        );

        if (missing.size > 0) {
            // Solo nombres de variables: nunca contenido (BLUEPRINT §17).
            throw new Error(
                `Prompt "${name}": faltan variables ${[...missing].map((v) => `{{${v}}}`).join(", ")}`,
            );
        }

        return rendered;
    }
}
