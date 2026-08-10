import http from "node:http";
import { AddressInfo } from "node:net";
import { SttSegment } from "../src/ai/stt-client";

/**
 * Mock HTTP del servicio local de transcripción (`faster-whisper-server`).
 * Calcado de `ai-helpers.ts`. Regla del proyecto: los tests NUNCA hablan con
 * el servicio real ni procesan audio de verdad.
 */

export interface RecordedSttRequest {
    /** Bytes del cuerpo multipart recibido. */
    bytes: number;
    /** Campos del formulario detectados en el multipart (valores de texto). */
    fields: Record<string, string>;
    receivedAt: number;
}

export interface MockSttResponse {
    status: number;
    body?: unknown;
}

export type SttResponder = (
    request: RecordedSttRequest,
    index: number,
) => MockSttResponse | Promise<MockSttResponse>;

export interface MockStt {
    url: string;
    requests: RecordedSttRequest[];
    readonly maxConcurrent: number;
    close(): Promise<void>;
}

/** Cuerpo `verbose_json` con los segmentos indicados. */
export function verboseJson(
    segments: Array<Partial<SttSegment> & { start: number; end: number; text: string }>,
): MockSttResponse {
    return {
        status: 200,
        body: {
            task: "transcribe",
            language: "es",
            duration: segments.reduce((max, s) => Math.max(max, s.end), 0),
            text: segments.map((s) => s.text).join(" "),
            segments: segments.map((s) => ({
                start: s.start,
                end: s.end,
                text: s.text,
                ...(s.noSpeechProb === undefined
                    ? {}
                    : { no_speech_prob: s.noSpeechProb }),
            })),
        },
    };
}

/**
 * Extrae los campos de texto de un multipart sin dependencias: basta con
 * localizar las cabeceras `name="…"` que NO llevan `filename`.
 */
function parseTextFields(raw: string): Record<string, string> {
    const fields: Record<string, string> = {};
    const pattern =
        /name="([^"]+)"(?!;)\r?\n\r?\n([\s\S]*?)\r?\n--/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(raw)) !== null) {
        fields[match[1]] = match[2];
    }
    return fields;
}

/** Arranca el mock en un puerto efímero de 127.0.0.1. */
export async function startMockStt(responder: SttResponder): Promise<MockStt> {
    const requests: RecordedSttRequest[] = [];
    let inFlight = 0;
    let maxConcurrent = 0;

    const server = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => {
            void (async () => {
                inFlight += 1;
                maxConcurrent = Math.max(maxConcurrent, inFlight);
                const raw = Buffer.concat(chunks);
                const request: RecordedSttRequest = {
                    bytes: raw.length,
                    fields: parseTextFields(raw.toString("latin1")),
                    receivedAt: Date.now(),
                };
                const index = requests.length;
                requests.push(request);
                try {
                    const response = await responder(request, index);
                    res.writeHead(response.status, {
                        "Content-Type": "application/json",
                    });
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

    await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
    );
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
