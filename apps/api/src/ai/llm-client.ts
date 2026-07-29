import { inject, injectable } from "@expressots/core";
import { z } from "zod";
import { AppEnv, ENV } from "../env";
import { AppError } from "../shared/errors";
import { PromptLoader } from "./prompts";

/**
 * Cliente HTTP hacia el modelo local (llama.cpp, API OpenAI-compatible).
 *
 * Garantías (BLUEPRINT §18, plan §F3):
 * - Solo habla con LLM_BASE_URL (local). Ningún dato sale de la máquina.
 * - Salida estructurada: `response_format: json_schema` (gramática en
 *   llama.cpp) + validación zod en runtime.
 * - Reintentos con backoff exponencial y temperatura creciente 0.2 → 0.4.
 * - Timeout por request con AbortSignal.timeout(LLM_TIMEOUT_MS).
 * - Concurrencia 1: llama.cpp sirve un modelo pequeño; nunca dos requests
 *   simultáneos (cola interna por promesa encadenada).
 * - Presupuesto de tokens: el prompt renderizado debe caber en
 *   LLM_CONTEXT_TOKENS menos un margen de salida.
 * - PRIVACIDAD (§17): jamás se loguea el contenido de prompts ni de
 *   respuestas; solo promptName, intento, duración y código de error.
 */

/** Estimación de chars por token para Gemma en español (~3.6). */
const CHARS_PER_TOKEN = 3.6;

/** Margen reservado para la salida del modelo dentro del contexto. */
export const OUTPUT_MARGIN_TOKENS = 2_000;

/** Base del backoff exponencial entre reintentos (ms). */
const BACKOFF_BASE_MS = 500;

/** Temperaturas del primer y último intento. */
const TEMPERATURE_FIRST = 0.2;
const TEMPERATURE_LAST = 0.4;

/** Estima el número de tokens de un texto (~3.6 caracteres por token). */
export function estimateTokens(text: string): number {
    return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * Trunca `text` para que quepa en `maxTokens` según {@link estimateTokens}.
 * Si ya cabe, lo devuelve intacto.
 */
export function truncateToBudget(text: string, maxTokens: number): string {
    const maxChars = Math.floor(maxTokens * CHARS_PER_TOKEN);
    return text.length <= maxChars ? text : text.slice(0, maxChars);
}

/** Parámetros de una llamada al modelo con salida estructurada. */
export interface CompleteParams<T> {
    /** Nombre del prompt en PROMPTS_DIR (sin extensión). */
    promptName: string;
    /** Variables a sustituir en la plantilla. */
    variables: Record<string, string>;
    /** JSON Schema para la gramática de llama.cpp (response_format). */
    schema: Record<string, unknown>;
    /** Schema zod espejo: valida la respuesta y tipa el resultado. */
    zodSchema: z.ZodType<T>;
}

/** Forma mínima de la respuesta de /v1/chat/completions. */
const chatCompletionResponseSchema = z.object({
    choices: z
        .array(
            z.object({
                message: z.object({ content: z.string() }),
            }),
        )
        .min(1),
});

@injectable()
export class LlmClient {
    /**
     * Cola de concurrencia 1: cada complete() se encadena al final de la
     * promesa anterior, de modo que nunca hay dos requests en vuelo.
     */
    private queue: Promise<unknown> = Promise.resolve();

    constructor(
        @inject(ENV) private readonly env: AppEnv,
        @inject(PromptLoader) private readonly prompts: PromptLoader,
    ) {}

    /**
     * Renderiza el prompt, llama al modelo con salida estructurada y devuelve
     * el objeto validado por zod. Reintenta ante error de red/HTTP, timeout,
     * JSON inválido o fallo de zod; si agota los reintentos lanza
     * AppError(LLM_UNAVAILABLE).
     */
    complete<T>(params: CompleteParams<T>): Promise<T> {
        const task = this.queue.then(
            () => this.doComplete(params),
            () => this.doComplete(params),
        );
        // La cola nunca queda rechazada: el error viaja solo al llamador.
        this.queue = task.then(
            () => undefined,
            () => undefined,
        );
        return task;
    }

    private async doComplete<T>(params: CompleteParams<T>): Promise<T> {
        const { promptName, variables, schema, zodSchema } = params;

        // Renderizado + presupuesto de tokens ANTES de tocar la red.
        // Un prompt que no cabe es un error del llamador, no del modelo.
        const rendered = this.prompts.render(promptName, variables);
        const inputBudget = this.env.LLM_CONTEXT_TOKENS - OUTPUT_MARGIN_TOKENS;
        const promptTokens = estimateTokens(rendered);
        if (promptTokens > inputBudget) {
            // Sin contenido del prompt en el error (§17): solo números.
            throw new AppError(
                "INVALID_INPUT",
                `El prompt "${promptName}" excede el presupuesto de contexto ` +
                    `(~${promptTokens} tokens estimados, máximo ${inputBudget}).`,
            );
        }

        const totalAttempts = Math.max(1, this.env.LLM_MAX_RETRIES + 1);

        for (let attempt = 0; attempt < totalAttempts; attempt++) {
            const startedAt = Date.now();
            try {
                const result = await this.requestOnce(
                    promptName,
                    rendered,
                    schema,
                    zodSchema,
                    this.temperatureFor(attempt, totalAttempts),
                );
                this.log(promptName, attempt, totalAttempts, startedAt, "ok");
                return result;
            } catch (error) {
                this.log(promptName, attempt, totalAttempts, startedAt, errorKind(error));
                if (attempt < totalAttempts - 1) {
                    await sleep(BACKOFF_BASE_MS * 2 ** attempt);
                }
            }
        }

        throw new AppError("LLM_UNAVAILABLE");
    }

    /** Un único request al modelo: fetch + parseo + validación zod. */
    private async requestOnce<T>(
        promptName: string,
        renderedPrompt: string,
        schema: Record<string, unknown>,
        zodSchema: z.ZodType<T>,
        temperature: number,
    ): Promise<T> {
        const response = await fetch(`${this.env.LLM_BASE_URL}/v1/chat/completions`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            signal: AbortSignal.timeout(this.env.LLM_TIMEOUT_MS),
            body: JSON.stringify({
                model: this.env.LLM_MODEL,
                messages: [{ role: "user", content: renderedPrompt }],
                temperature,
                response_format: {
                    type: "json_schema",
                    json_schema: {
                        name: promptName.replace(/[^a-zA-Z0-9_-]/g, "_"),
                        schema,
                        strict: true,
                    },
                },
            }),
        });

        if (!response.ok) {
            throw new HttpStatusError(response.status);
        }

        const body: unknown = await response.json();
        const content = chatCompletionResponseSchema.parse(body).choices[0].message.content;
        return zodSchema.parse(JSON.parse(content));
    }

    /**
     * Temperatura del intento: 0.2 en el primero, subiendo linealmente hasta
     * 0.4 en el último. Con un solo intento se usa 0.2.
     */
    private temperatureFor(attempt: number, totalAttempts: number): number {
        if (totalAttempts <= 1) {
            return TEMPERATURE_FIRST;
        }
        const step = (TEMPERATURE_LAST - TEMPERATURE_FIRST) / (totalAttempts - 1);
        return Math.round((TEMPERATURE_FIRST + step * attempt) * 100) / 100;
    }

    /**
     * Log seguro (§17): solo nombre de prompt, intento, duración y tipo de
     * resultado. NUNCA contenido de prompts ni de respuestas.
     */
    private log(
        promptName: string,
        attempt: number,
        totalAttempts: number,
        startedAt: number,
        outcome: string,
    ): void {
        const durationMs = Date.now() - startedAt;
        const line = `[llm] prompt=${promptName} attempt=${attempt + 1}/${totalAttempts} outcome=${outcome} duration_ms=${durationMs}`;
        if (outcome === "ok") {
            console.info(line);
        } else {
            console.warn(line);
        }
    }
}

/** Error interno para respuestas HTTP no-2xx del modelo. */
class HttpStatusError extends Error {
    constructor(readonly status: number) {
        super(`HTTP ${status}`);
        this.name = "HttpStatusError";
    }
}

/** Clasifica el error de un intento en un código apto para logs. */
function errorKind(error: unknown): string {
    if (error instanceof HttpStatusError) {
        return `http_${error.status}`;
    }
    if (error instanceof z.ZodError) {
        return "schema_invalid";
    }
    if (error instanceof SyntaxError) {
        return "json_invalid";
    }
    if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
        return "timeout";
    }
    return "network_error";
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
