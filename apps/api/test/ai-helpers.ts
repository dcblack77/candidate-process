import { mkdtempSync, writeFileSync } from "node:fs";
import http from "node:http";
import { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { AppEnv } from "../src/env";

/**
 * Utilidades de los tests ai-*: servidor HTTP mock que simula llama.cpp
 * (API OpenAI-compatible), entorno falso y prompts temporales.
 * Regla del proyecto: los tests NUNCA hablan con el modelo real.
 */

export interface RecordedRequest {
    /** Body JSON recibido en POST /v1/chat/completions. */
    body: {
        model: string;
        messages: Array<{ role: string; content: string }>;
        temperature: number;
        response_format: {
            type: string;
            json_schema: { name: string; schema: unknown; strict: boolean };
        };
    };
    receivedAt: number;
}

export interface MockResponse {
    status: number;
    body?: unknown;
}

export type Responder = (
    request: RecordedRequest,
    index: number,
) => MockResponse | Promise<MockResponse>;

export interface MockLlm {
    url: string;
    requests: RecordedRequest[];
    /** Máximo de requests procesándose a la vez (para el test de concurrencia). */
    readonly maxConcurrent: number;
    close(): Promise<void>;
}

/** Respuesta 200 de chat/completions cuyo message.content es `content`. */
export function chatCompletion(content: unknown): MockResponse {
    const text = typeof content === "string" ? content : JSON.stringify(content);
    return {
        status: 200,
        body: { choices: [{ message: { content: text } }] },
    };
}

/** Arranca un mock de llama.cpp en un puerto efímero de 127.0.0.1. */
export async function startMockLlm(responder: Responder): Promise<MockLlm> {
    const requests: RecordedRequest[] = [];
    let inFlight = 0;
    let maxConcurrent = 0;

    const server = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => {
            void (async () => {
                inFlight += 1;
                maxConcurrent = Math.max(maxConcurrent, inFlight);
                const request: RecordedRequest = {
                    body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
                    receivedAt: Date.now(),
                };
                const index = requests.length;
                requests.push(request);
                try {
                    const response = await responder(request, index);
                    res.writeHead(response.status, { "Content-Type": "application/json" });
                    res.end(JSON.stringify(response.body ?? {}));
                } catch {
                    res.writeHead(500);
                    res.end();
                } finally {
                    inFlight -= 1;
                }
            })();
        });
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;

    return {
        url: `http://127.0.0.1:${port}`,
        requests,
        get maxConcurrent() {
            return maxConcurrent;
        },
        close: () =>
            new Promise<void>((resolve, reject) => {
                server.closeAllConnections();
                server.close((error) => (error ? reject(error) : resolve()));
            }),
    };
}

/** Crea un directorio temporal de prompts con los archivos indicados. */
export function createPromptsDir(files: Record<string, string>): string {
    const dir = mkdtempSync(path.join(os.tmpdir(), "ai-prompts-"));
    for (const [name, content] of Object.entries(files)) {
        writeFileSync(path.join(dir, `${name}.md`), content, "utf8");
    }
    return dir;
}

/** Entorno falso para instanciar PromptLoader/LlmClient sin contenedor DI. */
export function makeAiEnv(overrides: Partial<AppEnv> = {}): AppEnv {
    return {
        API_HOST: "127.0.0.1",
        API_PORT: 3010,
        DB_PATH: ":memory:",
        LLM_BASE_URL: "http://127.0.0.1:9",
        LLM_MODEL: "test-model",
        LLM_TIMEOUT_MS: 5_000,
        LLM_MAX_RETRIES: 1,
        LLM_CONTEXT_TOKENS: 22_016,
        PROMPTS_DIR: os.tmpdir(),
        REPO_ROOT: process.cwd(),
        ...overrides,
    };
}
