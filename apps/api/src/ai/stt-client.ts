import { inject, injectable } from "@expressots/core";
import { z } from "zod";
import { AppEnv, ENV } from "../env";
import { AppError } from "../shared/errors";

/**
 * Cliente HTTP hacia el servicio local de transcripción (BLUEPRINT §24).
 *
 * Es `faster-whisper-server` (contenedor `voice-stt` del stack de
 * /opt/ai-server, perfil `voice`), API compatible con OpenAI. NO cuelga del
 * router de :8080: ese router no enruta audio y devolvería 500.
 *
 * Garantías, calcadas de {@link LlmClient}:
 * - Solo habla con STT_BASE_URL (local). Ningún audio sale de la máquina.
 * - Concurrencia 1: whisper corre en CPU y dos transcripciones a la vez solo
 *   se estorban.
 * - Timeout propio y MUY superior al del modelo de texto: una pista de 50
 *   minutos tarda ~4,5 minutos, y con los 120 s del LLM se cortaría siempre.
 * - PRIVACIDAD (§17): los logs llevan bytes, duración y número de segmentos.
 *   JAMÁS una línea del texto transcrito.
 *
 * Se manda el WebM/Opus del navegador tal cual: el servicio lo acepta y así
 * se evita pasar el audio por ffmpeg (un archivo temporal en disco sería
 * justo lo que §17 prohíbe).
 */

/** Un intento de reintento: la transcripción es cara, no se insiste mucho. */
const MAX_ATTEMPTS = 2;

/** Segmento tal y como lo devuelve whisper en `verbose_json`. */
export interface SttSegment {
    /** Segundos desde el inicio de la pista. */
    start: number;
    end: number;
    text: string;
    /**
     * Probabilidad de que el segmento sea silencio. Opcional: no todos los
     * servidores la envían, y el código no puede depender de ella.
     */
    noSpeechProb?: number;
}

export interface SttResult {
    /** Duración de la pista en segundos, según el servicio. */
    durationSec: number;
    segments: SttSegment[];
}

/**
 * Respuesta de `verbose_json`. Permisiva a propósito (`.passthrough()` en los
 * segmentos): el servidor puede añadir campos y eso no debe romper nada.
 */
const verboseJsonSchema = z.object({
    duration: z.number().optional(),
    segments: z
        .array(
            z
                .object({
                    start: z.number(),
                    end: z.number(),
                    text: z.string(),
                    no_speech_prob: z.number().optional(),
                })
                .passthrough(),
        )
        .optional(),
    text: z.string().optional(),
});

@injectable()
export class SttClient {
    /** Cola de concurrencia 1, misma técnica que LlmClient. */
    private queue: Promise<unknown> = Promise.resolve();

    constructor(@inject(ENV) private readonly env: AppEnv) {}

    /**
     * Transcribe una pista de audio. `label` solo se usa en logs ("mic",
     * "tab"): nunca viaja al servicio ni identifica a nadie.
     *
     * Lanza AppError(STT_UNAVAILABLE) al agotar los intentos.
     */
    transcribe(
        audio: Buffer,
        label: string,
        signal?: AbortSignal,
    ): Promise<SttResult> {
        const task = this.queue.then(
            () => this.doTranscribe(audio, label, signal),
            () => this.doTranscribe(audio, label, signal),
        );
        this.queue = task.then(
            () => undefined,
            () => undefined,
        );
        return task;
    }

    private async doTranscribe(
        audio: Buffer,
        label: string,
        signal?: AbortSignal,
    ): Promise<SttResult> {
        for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
            const startedAt = Date.now();
            try {
                const result = await this.requestOnce(audio, signal);
                this.log(label, attempt, startedAt, "ok", audio.length, result);
                return result;
            } catch (error) {
                this.log(
                    label,
                    attempt,
                    startedAt,
                    errorKind(error),
                    audio.length,
                );
                // Una cancelación no se reintenta: es una decisión del usuario.
                if (signal?.aborted) {
                    throw error;
                }
            }
        }
        throw new AppError("STT_UNAVAILABLE");
    }

    private async requestOnce(
        audio: Buffer,
        signal?: AbortSignal,
    ): Promise<SttResult> {
        const form = new FormData();
        // El nombre de archivo es fijo y anodino: nunca el del candidato.
        form.append(
            "file",
            new Blob([new Uint8Array(audio)], { type: "audio/webm" }),
            "interview.webm",
        );
        form.append("model", this.env.STT_MODEL);
        form.append("language", this.env.STT_LANGUAGE);
        form.append("response_format", "verbose_json");
        form.append("timestamp_granularities[]", "segment");
        // Recorta silencios: acelera la pista del micrófono, que es sobre todo
        // silencio, y reduce las alucinaciones de whisper sobre el vacío.
        form.append("vad_filter", "true");

        const response = await fetch(
            `${this.env.STT_BASE_URL}/v1/audio/transcriptions`,
            {
                method: "POST",
                body: form,
                signal: combineSignals(
                    AbortSignal.timeout(this.env.STT_TIMEOUT_MS),
                    signal,
                ),
            },
        );

        if (!response.ok) {
            throw new HttpStatusError(response.status);
        }

        const parsed = verboseJsonSchema.parse(await response.json());
        const segments = (parsed.segments ?? []).map((segment) => ({
            start: segment.start,
            end: segment.end,
            text: segment.text,
            noSpeechProb: segment.no_speech_prob,
        }));

        return {
            durationSec:
                parsed.duration ??
                segments.reduce((max, s) => Math.max(max, s.end), 0),
            segments,
        };
    }

    /**
     * Log seguro (§17): pista, intento, duración, bytes y cuántos segmentos.
     * NUNCA el texto.
     */
    private log(
        label: string,
        attempt: number,
        startedAt: number,
        outcome: string,
        bytes: number,
        result?: SttResult,
    ): void {
        const parts = [
            `[stt] track=${label}`,
            `attempt=${attempt + 1}/${MAX_ATTEMPTS}`,
            `outcome=${outcome}`,
            `bytes=${bytes}`,
            `duration_ms=${Date.now() - startedAt}`,
        ];
        if (result) {
            parts.push(
                `audio_sec=${Math.round(result.durationSec)}`,
                `segments=${result.segments.length}`,
            );
        }
        const line = parts.join(" ");
        if (outcome === "ok") {
            console.info(line);
        } else {
            console.warn(line);
        }
    }
}

/** Error interno para respuestas HTTP no-2xx del servicio de transcripción. */
class HttpStatusError extends Error {
    constructor(readonly status: number) {
        super(`HTTP ${status}`);
        this.name = "HttpStatusError";
    }
}

function errorKind(error: unknown): string {
    if (error instanceof HttpStatusError) {
        return `http_${error.status}`;
    }
    if (error instanceof z.ZodError) {
        return "schema_invalid";
    }
    if (
        error instanceof Error &&
        (error.name === "TimeoutError" || error.name === "AbortError")
    ) {
        return "timeout";
    }
    return "network_error";
}

/**
 * Une el timeout con la señal de cancelación del job. `AbortSignal.any` es
 * nativo en Node 22; el fallback existe por si el runtime de un test no lo
 * trae.
 */
function combineSignals(
    timeout: AbortSignal,
    external?: AbortSignal,
): AbortSignal {
    if (!external) {
        return timeout;
    }
    if (typeof AbortSignal.any === "function") {
        return AbortSignal.any([timeout, external]);
    }
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    timeout.addEventListener("abort", abort, { once: true });
    external.addEventListener("abort", abort, { once: true });
    return controller.signal;
}
