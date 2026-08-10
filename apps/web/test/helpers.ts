import { vi } from "vitest";

/**
 * Utilidades de test: fetch mockeado (NUNCA se llama a la API real).
 */

export interface FetchCall {
    url: string;
    init: RequestInit;
}

/** Respuesta mínima compatible con lo que usa el cliente (ok/status/json). */
export function jsonResponse(data: unknown, status = 200) {
    return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => data,
    } as unknown as Response;
}

/**
 * Instala un fetch mockeado que resuelve por prefijo "MÉTODO ruta"
 * (p. ej. "GET /api/candidates"). Devuelve el mock y el registro de llamadas.
 */
export function installFetchMock(
    routes: Record<string, () => Response | Promise<Response>>,
) {
    const calls: FetchCall[] = [];
    const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = (init?.method ?? "GET").toUpperCase();
        calls.push({ url, init: init ?? {} });
        const key = Object.keys(routes).find((route) => {
            const [routeMethod, routePath] = route.split(" ");
            return method === routeMethod && url === routePath;
        });
        if (!key) {
            throw new Error(`Ruta no mockeada en el test: ${method} ${url}`);
        }
        return routes[key]!();
    });
    vi.stubGlobal("fetch", mock);
    return { mock, calls };
}

/**
 * Dobles mínimos de las APIs de medios: jsdom no trae `MediaRecorder`,
 * `AudioContext` ni `MediaStream`, y sin ellos la captura de entrevista (§24)
 * no se puede probar.
 *
 * `tabAudioTracks: 0` simula el error que va a pasar la primera vez que
 * alguien la use: compartir la pestaña sin marcar la casilla del audio.
 */
export interface MediaMockOptions {
    secureContext?: boolean;
    getUserMedia?: boolean;
    getDisplayMedia?: boolean;
    /** Pistas de audio que devuelve getDisplayMedia. */
    tabAudioTracks?: number;
    /** Error que lanza getUserMedia, por nombre (NotAllowedError…). */
    micError?: string;
}

export interface MediaMocks {
    stoppedTracks: number;
    recorders: Array<{ mimeType: string; stopped: boolean }>;
    audioContextClosed: boolean;
}

export function installMediaMocks(options: MediaMockOptions = {}): MediaMocks {
    const {
        secureContext = true,
        getUserMedia = true,
        getDisplayMedia = true,
        tabAudioTracks = 1,
        micError,
    } = options;

    const state: MediaMocks = {
        stoppedTracks: 0,
        recorders: [],
        audioContextClosed: false,
    };

    function makeTrack(kind: "audio" | "video") {
        return { kind, stop: () => (state.stoppedTracks += 1) };
    }

    function makeStream(audio: number, video = 0) {
        const tracks = [
            ...Array.from({ length: audio }, () => makeTrack("audio")),
            ...Array.from({ length: video }, () => makeTrack("video")),
        ];
        return {
            getTracks: () => tracks,
            getAudioTracks: () => tracks.filter((t) => t.kind === "audio"),
            getVideoTracks: () => tracks.filter((t) => t.kind === "video"),
            removeTrack: (track: unknown) => {
                const at = tracks.indexOf(track as (typeof tracks)[number]);
                if (at >= 0) {
                    tracks.splice(at, 1);
                }
            },
        };
    }

    vi.stubGlobal("isSecureContext", secureContext);
    Object.defineProperty(window, "isSecureContext", {
        value: secureContext,
        configurable: true,
    });

    const mediaDevices: Record<string, unknown> = {};
    if (getUserMedia) {
        mediaDevices.getUserMedia = vi.fn(async () => {
            if (micError) {
                const error = new Error("denegado");
                error.name = micError;
                throw error;
            }
            return makeStream(1);
        });
    }
    if (getDisplayMedia) {
        mediaDevices.getDisplayMedia = vi.fn(async () =>
            makeStream(tabAudioTracks, 1),
        );
    }
    Object.defineProperty(navigator, "mediaDevices", {
        value: secureContext ? mediaDevices : undefined,
        configurable: true,
    });

    class FakeMediaRecorder {
        static isTypeSupported = (): boolean => true;
        state: "inactive" | "recording" = "inactive";
        ondataavailable: ((event: { data: Blob }) => void) | null = null;
        onstop: (() => void) | null = null;
        private entry: { mimeType: string; stopped: boolean };

        constructor(
            _stream: unknown,
            options?: { mimeType?: string },
        ) {
            this.entry = {
                mimeType: options?.mimeType ?? "",
                stopped: false,
            };
            state.recorders.push(this.entry);
        }
        start(): void {
            this.state = "recording";
            // Un trozo inmediato: así `stop()` siempre produce un Blob.
            this.ondataavailable?.({ data: new Blob(["audio"]) });
        }
        stop(): void {
            this.state = "inactive";
            this.entry.stopped = true;
            this.onstop?.();
        }
    }
    vi.stubGlobal("MediaRecorder", FakeMediaRecorder);

    class FakeAnalyser {
        fftSize = 512;
        connect(): void {}
        getByteTimeDomainData(buffer: Uint8Array): void {
            buffer.fill(128);
        }
    }
    class FakeAudioContext {
        createAnalyser(): FakeAnalyser {
            return new FakeAnalyser();
        }
        createMediaStreamSource(): { connect: (a: unknown) => void } {
            return { connect: () => undefined };
        }
        close(): Promise<void> {
            state.audioContextClosed = true;
            return Promise.resolve();
        }
    }
    vi.stubGlobal("AudioContext", FakeAudioContext);
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) =>
        setTimeout(() => cb(0), 16),
    );
    vi.stubGlobal("cancelAnimationFrame", (id: number) =>
        clearTimeout(id as unknown as NodeJS.Timeout),
    );

    return state;
}
