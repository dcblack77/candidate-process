import { afterEach, describe, expect, it, vi } from "vitest";
import { SttClient } from "../src/ai/stt-client";
import { AppError } from "../src/shared/errors";
import { makeAiEnv } from "./ai-helpers";
import { MockStt, startMockStt, verboseJson } from "./stt-helpers";

/**
 * Cliente del servicio local de transcripción (§24). Nunca habla con el
 * servicio real: siempre contra el mock de `stt-helpers.ts`.
 */

let mock: MockStt | undefined;

afterEach(async () => {
    await mock?.close();
    mock = undefined;
    vi.restoreAllMocks();
});

async function clientFor(
    responder: Parameters<typeof startMockStt>[0],
): Promise<SttClient> {
    mock = await startMockStt(responder);
    return new SttClient(makeAiEnv({ STT_BASE_URL: mock.url }));
}

/** El mock activo. Falla el test si se usa antes de arrancarlo. */
function activeMock(): MockStt {
    if (!mock) {
        throw new Error("El mock de transcripción no está arrancado");
    }
    return mock;
}

const AUDIO = Buffer.from("webm-falso-para-el-test");

describe("SttClient.transcribe", () => {
    it("devuelve los segmentos con sus marcas de tiempo", async () => {
        const client = await clientFor(() =>
            verboseJson([
                { start: 0, end: 4.5, text: "particionamos el dominio" },
                { start: 5, end: 9, text: "y medimos la latencia" },
            ]),
        );

        const result = await client.transcribe(AUDIO, "tab");

        expect(result.durationSec).toBe(9);
        expect(result.segments).toEqual([
            { start: 0, end: 4.5, text: "particionamos el dominio", noSpeechProb: undefined },
            { start: 5, end: 9, text: "y medimos la latencia", noSpeechProb: undefined },
        ]);
    });

    it("manda el formulario que espera faster-whisper-server", async () => {
        const client = await clientFor(() => verboseJson([]));
        await client.transcribe(AUDIO, "mic");

        const { fields, bytes } = activeMock().requests[0];
        expect(fields.model).toBe("test-stt-model");
        expect(fields.language).toBe("es");
        expect(fields.response_format).toBe("verbose_json");
        // Recorta silencios: es lo que abarata la pista del micrófono y
        // reduce las alucinaciones de whisper sobre el vacío.
        expect(fields.vad_filter).toBe("true");
        expect(bytes).toBeGreaterThan(AUDIO.length);
    });

    it("propaga no_speech_prob cuando el servidor lo envía", async () => {
        const client = await clientFor(() =>
            verboseJson([
                { start: 0, end: 2, text: "algo", noSpeechProb: 0.92 },
            ]),
        );
        const result = await client.transcribe(AUDIO, "tab");
        expect(result.segments[0].noSpeechProb).toBe(0.92);
    });

    it("deduce la duración si el servidor no la manda", async () => {
        const client = await clientFor(() => ({
            status: 200,
            body: { segments: [{ start: 0, end: 12.5, text: "hola" }] },
        }));
        const result = await client.transcribe(AUDIO, "tab");
        expect(result.durationSec).toBe(12.5);
    });

    it("reintenta una vez y sale adelante", async () => {
        const client = await clientFor((_req, index) =>
            index === 0
                ? { status: 500 }
                : verboseJson([{ start: 0, end: 1, text: "vale" }]),
        );

        const result = await client.transcribe(AUDIO, "tab");
        expect(result.segments).toHaveLength(1);
        expect(activeMock().requests).toHaveLength(2);
    });

    it("agotados los intentos lanza STT_UNAVAILABLE, no un 500 pelado", async () => {
        const client = await clientFor(() => ({ status: 503 }));

        await expect(client.transcribe(AUDIO, "tab")).rejects.toMatchObject({
            code: "STT_UNAVAILABLE",
            httpStatus: 502,
        });
        expect(activeMock().requests).toHaveLength(2);
    });

    it("una respuesta que no encaja con el contrato también acaba en STT_UNAVAILABLE", async () => {
        const client = await clientFor(() => ({
            status: 200,
            body: { segments: [{ start: "no-es-un-numero", end: 1, text: "x" }] },
        }));
        await expect(client.transcribe(AUDIO, "tab")).rejects.toBeInstanceOf(
            AppError,
        );
    });

    it("serializa: whisper en CPU nunca recibe dos pistas a la vez", async () => {
        const client = await clientFor(async () => {
            await new Promise((resolve) => setTimeout(resolve, 60));
            return verboseJson([{ start: 0, end: 1, text: "ok" }]);
        });

        await Promise.all([
            client.transcribe(AUDIO, "mic"),
            client.transcribe(AUDIO, "tab"),
        ]);

        expect(activeMock().maxConcurrent).toBe(1);
    });

    it("un fallo no deja la cola rota: la siguiente pista funciona", async () => {
        const client = await clientFor((_req, index) =>
            index < 2
                ? { status: 500 }
                : verboseJson([{ start: 0, end: 1, text: "segunda" }]),
        );

        await expect(client.transcribe(AUDIO, "mic")).rejects.toBeInstanceOf(
            AppError,
        );
        const result = await client.transcribe(AUDIO, "tab");
        expect(result.segments[0].text).toBe("segunda");
    });

    it("cancelar aborta sin reintentar", async () => {
        const controller = new AbortController();
        const client = await clientFor(async () => {
            controller.abort();
            await new Promise((resolve) => setTimeout(resolve, 30));
            return verboseJson([]);
        });

        await expect(
            client.transcribe(AUDIO, "tab", controller.signal),
        ).rejects.toThrow();
        // Un solo intento: cancelar es una decisión del usuario, no un fallo.
        expect(activeMock().requests).toHaveLength(1);
    });

    it("no escribe el texto transcrito en los logs (§17)", async () => {
        const info = vi.spyOn(console, "info").mockImplementation(() => {});
        const client = await clientFor(() =>
            verboseJson([
                { start: 0, end: 3, text: "cobro cuarenta mil euros al año" },
            ]),
        );

        await client.transcribe(AUDIO, "tab");

        const logged = info.mock.calls.flat().join(" ");
        expect(logged).toContain("[stt]");
        expect(logged).toContain("segments=1");
        expect(logged).not.toContain("cuarenta mil");
    });
});
