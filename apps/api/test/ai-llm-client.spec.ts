import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { estimateTokens, LlmClient, OUTPUT_MARGIN_TOKENS } from "../src/ai/llm-client";
import { PromptLoader } from "../src/ai/prompts";
import { AppError } from "../src/shared/errors";
import {
    chatCompletion,
    createPromptsDir,
    makeAiEnv,
    MockLlm,
    Responder,
    startMockLlm,
} from "./ai-helpers";

/**
 * Contrato del LlmClient contra un servidor HTTP mock local (node:http en
 * puerto efímero) que simula llama.cpp. Ningún test toca el modelo real.
 */

const PROMPT = "Analiza el tema {{topic}} y responde en JSON.";

const ANSWER_JSON_SCHEMA = {
    type: "object",
    additionalProperties: false,
    required: ["answer"],
    properties: { answer: { type: "string" } },
} as const;

const answerZodSchema = z.object({ answer: z.string() }).strict();

const promptsDir = createPromptsDir({ "test-prompt": PROMPT });

let mock: MockLlm | undefined;

async function startMock(responder: Responder): Promise<MockLlm> {
    mock = await startMockLlm(responder);
    return mock;
}

function makeClient(server: MockLlm, envOverrides: Record<string, unknown> = {}): LlmClient {
    const env = makeAiEnv({
        PROMPTS_DIR: promptsDir,
        LLM_BASE_URL: server.url,
        ...envOverrides,
    });
    return new LlmClient(env, new PromptLoader(env));
}

function completeTopic(client: LlmClient, topic = "grafos"): Promise<{ answer: string }> {
    return client.complete({
        promptName: "test-prompt",
        variables: { topic },
        schema: ANSWER_JSON_SCHEMA as unknown as Record<string, unknown>,
        zodSchema: answerZodSchema,
    });
}

afterEach(async () => {
    vi.restoreAllMocks();
    await mock?.close();
    mock = undefined;
});

describe("LlmClient.complete", () => {
    it("respuesta JSON válida → objeto tipado y contrato OpenAI-compatible correcto", async () => {
        const server = await startMock(() => chatCompletion({ answer: "42" }));
        const client = makeClient(server);

        const result = await completeTopic(client, "grafos dirigidos");

        expect(result).toEqual({ answer: "42" });
        expect(server.requests).toHaveLength(1);

        const body = server.requests[0].body;
        expect(body.model).toBe("test-model");
        expect(body.messages).toHaveLength(1);
        expect(body.messages[0].role).toBe("user");
        expect(body.messages[0].content).toContain("grafos dirigidos");
        expect(body.temperature).toBe(0.2);
        expect(body.response_format.type).toBe("json_schema");
        expect(body.response_format.json_schema.strict).toBe(true);
        expect(body.response_format.json_schema.name).toBe("test-prompt");
        expect(body.response_format.json_schema.schema).toEqual(ANSWER_JSON_SCHEMA);
    });

    it("JSON que viola el schema zod → reintenta con temperatura creciente y triunfa a la 2ª", async () => {
        const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
        const server = await startMock((_request, index) =>
            index === 0 ? chatCompletion({ wrong_field: true }) : chatCompletion({ answer: "ok" }),
        );
        // 3 intentos máximos (1 + 2 reintentos): temperaturas 0.2 → 0.3 → 0.4.
        const client = makeClient(server, { LLM_MAX_RETRIES: 2 });

        const result = await completeTopic(client, "tema-secreto-del-cv");

        expect(result).toEqual({ answer: "ok" });
        expect(server.requests).toHaveLength(2);
        expect(server.requests[0].body.temperature).toBe(0.2);
        expect(server.requests[1].body.temperature).toBe(0.3);
        expect(server.requests[1].body.temperature).toBeGreaterThan(
            server.requests[0].body.temperature,
        );

        // Privacidad (§17): los logs jamás contienen contenido del prompt.
        const logged = warnSpy.mock.calls.flat().join(" ");
        expect(logged).toContain("test-prompt");
        expect(logged).not.toContain("tema-secreto-del-cv");
    });

    it("content que no es JSON parseable → reintenta y triunfa con la siguiente válida", async () => {
        const server = await startMock((_request, index) =>
            index === 0 ? chatCompletion("esto no es JSON {") : chatCompletion({ answer: "bien" }),
        );
        const client = makeClient(server, { LLM_MAX_RETRIES: 1 });

        await expect(completeTopic(client)).resolves.toEqual({ answer: "bien" });
        expect(server.requests).toHaveLength(2);
    });

    it("500 persistente → AppError LLM_UNAVAILABLE tras agotar LLM_MAX_RETRIES", async () => {
        vi.spyOn(console, "warn").mockImplementation(() => undefined);
        const server = await startMock(() => ({ status: 500, body: { error: "boom" } }));
        const client = makeClient(server, { LLM_MAX_RETRIES: 2 });

        const failure = await completeTopic(client).catch((error: unknown) => error);

        expect(failure).toBeInstanceOf(AppError);
        expect((failure as AppError).code).toBe("LLM_UNAVAILABLE");
        expect((failure as AppError).httpStatus).toBe(502);
        // 1 intento inicial + LLM_MAX_RETRIES reintentos.
        expect(server.requests).toHaveLength(3);
    }, 10_000);

    it("timeout por request (AbortSignal) → reintenta y falla con LLM_UNAVAILABLE", async () => {
        vi.spyOn(console, "warn").mockImplementation(() => undefined);
        const server = await startMock(async () => {
            await new Promise((resolve) => setTimeout(resolve, 1_000));
            return chatCompletion({ answer: "tarde" });
        });
        const client = makeClient(server, { LLM_TIMEOUT_MS: 100, LLM_MAX_RETRIES: 1 });

        const failure = await completeTopic(client).catch((error: unknown) => error);

        expect(failure).toBeInstanceOf(AppError);
        expect((failure as AppError).code).toBe("LLM_UNAVAILABLE");
        expect(server.requests).toHaveLength(2);
    }, 10_000);

    it("concurrencia 1: dos complete() simultáneos llegan al mock secuencialmente", async () => {
        const server = await startMock(async (request) => {
            await new Promise((resolve) => setTimeout(resolve, 100));
            return chatCompletion({ answer: request.body.messages[0].content.includes("uno") ? "1" : "2" });
        });
        const client = makeClient(server);

        const [first, second] = await Promise.all([
            completeTopic(client, "uno"),
            completeTopic(client, "dos"),
        ]);

        expect(first).toEqual({ answer: "1" });
        expect(second).toEqual({ answer: "2" });
        expect(server.requests).toHaveLength(2);
        expect(server.maxConcurrent).toBe(1);
        // El segundo request no salió hasta terminar el primero (≥100ms después).
        expect(server.requests[1].receivedAt - server.requests[0].receivedAt).toBeGreaterThanOrEqual(90);
    });

    it("la cola sobrevive a errores: tras un fallo, la siguiente llamada funciona", async () => {
        vi.spyOn(console, "warn").mockImplementation(() => undefined);
        const server = await startMock((_request, index) =>
            index === 0 ? { status: 500 } : chatCompletion({ answer: "recuperado" }),
        );
        const client = makeClient(server, { LLM_MAX_RETRIES: 0 });

        await expect(completeTopic(client)).rejects.toBeInstanceOf(AppError);
        await expect(completeTopic(client)).resolves.toEqual({ answer: "recuperado" });
    });

    it("prompt que excede el presupuesto de contexto → INVALID_INPUT sin tocar la red", async () => {
        const server = await startMock(() => chatCompletion({ answer: "no debería llegar" }));
        // Presupuesto de entrada: 2100 - 2000 = 100 tokens (~360 chars).
        const client = makeClient(server, { LLM_CONTEXT_TOKENS: OUTPUT_MARGIN_TOKENS + 100 });

        const hugeTopic = "z".repeat(2_000);
        expect(estimateTokens(hugeTopic)).toBeGreaterThan(100);

        const failure = await completeTopic(client, hugeTopic).catch((error: unknown) => error);

        expect(failure).toBeInstanceOf(AppError);
        expect((failure as AppError).code).toBe("INVALID_INPUT");
        // El contenido del prompt NUNCA viaja en el mensaje de error.
        expect((failure as AppError).message).not.toContain("zzz");
        expect(server.requests).toHaveLength(0);
    });
});
