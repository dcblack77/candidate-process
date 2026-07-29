import { existsSync } from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import { z } from "zod";

/**
 * Configuración de entorno (plan §Configuración).
 * Carga `.env` desde la raíz del repo y valida con zod.
 *
 * Invariante (BLUEPRINT §10): la API solo escucha en localhost. Si API_HOST
 * apunta a otra interfaz se fuerza 127.0.0.1 y se avisa por consola.
 */

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

const envSchema = z.object({
    API_HOST: z.string().default("127.0.0.1"),
    API_PORT: z.coerce.number().int().min(1).max(65_535).default(3010),
    DB_PATH: z.string().default("./data/local.db"),
    LLM_BASE_URL: z.string().url().default("http://localhost:8080"),
    LLM_MODEL: z.string().default("gemma-4-E2B-it-qat-UD-Q4_K_XL"),
    LLM_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),
    LLM_MAX_RETRIES: z.coerce.number().int().min(0).default(3),
    LLM_CONTEXT_TOKENS: z.coerce.number().int().positive().default(22_016),
    PROMPTS_DIR: z.string().default("./prompts"),
});

/** Entorno tipado de la aplicación. Las rutas ya vienen resueltas a absolutas. */
export interface AppEnv extends z.infer<typeof envSchema> {
    /** Raíz del repositorio (donde vive pnpm-workspace.yaml). */
    REPO_ROOT: string;
}

/** Token DI para inyectar el entorno tipado. */
export const ENV = Symbol.for("AppEnv");

/**
 * Localiza la raíz del repo subiendo desde `startDir` hasta encontrar
 * pnpm-workspace.yaml. Permite ejecutar la API tanto desde la raíz como
 * desde apps/api sin romper las rutas relativas de .env.
 */
export function findRepoRoot(startDir: string = process.cwd()): string {
    let dir = path.resolve(startDir);
    for (;;) {
        if (existsSync(path.join(dir, "pnpm-workspace.yaml"))) {
            return dir;
        }
        const parent = path.dirname(dir);
        if (parent === dir) {
            // No se encontró: usamos el directorio inicial como último recurso.
            return path.resolve(startDir);
        }
        dir = parent;
    }
}

let cached: AppEnv | undefined;

/**
 * Carga y valida el entorno. Memoizado: la primera llamada lee `.env`,
 * las siguientes devuelven el mismo objeto congelado.
 */
export function loadEnv(): AppEnv {
    if (cached) {
        return cached;
    }

    const repoRoot = findRepoRoot();
    dotenv.config({ path: path.join(repoRoot, ".env") });

    const parsed = envSchema.parse(process.env);

    if (!LOCAL_HOSTS.has(parsed.API_HOST)) {
        console.warn(
            `[env] API_HOST="${parsed.API_HOST}" no es una interfaz local. ` +
                "Se fuerza 127.0.0.1: la API nunca se expone fuera de localhost (BLUEPRINT §10).",
        );
        parsed.API_HOST = "127.0.0.1";
    }

    cached = Object.freeze({
        ...parsed,
        REPO_ROOT: repoRoot,
        DB_PATH: path.resolve(repoRoot, parsed.DB_PATH),
        PROMPTS_DIR: path.resolve(repoRoot, parsed.PROMPTS_DIR),
    });
    return cached;
}
