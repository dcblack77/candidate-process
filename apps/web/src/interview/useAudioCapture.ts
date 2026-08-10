import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Captura del audio de una entrevista desde el navegador (BLUEPRINT §24,
 * Fase B): micrófono de la sala + audio de la pestaña de la videollamada.
 *
 * DOS PISTAS SEPARADAS, nunca mezcladas. whisper no diariza: si el micro y la
 * videollamada llegan en una sola pista, nada distingue lo que dijo el
 * candidato de lo que preguntó el entrevistador, y ese falso positivo es
 * irrecuperable aguas abajo. Grabando por separado la atribución de hablante
 * es un dato.
 *
 * CONTEXTO SEGURO: `getUserMedia` y `getDisplayMedia` solo existen en HTTPS o
 * en localhost. No es una comprobación nuestra que se pueda relajar: sobre
 * `http://192.168.1.10:5173` la propiedad `navigator.mediaDevices` ni siquiera
 * existe. Por eso el servidor de desarrollo sirve HTTPS con certificado propio
 * (ver `dev/tls.ts`). Si aun así se llega por HTTP en claro, el hook lo detecta
 * y la UI ofrece la dirección cifrada y el camino de subir el archivo. Nunca
 * revienta la pantalla.
 */

export type CaptureState = "idle" | "requesting" | "recording" | "stopped";

export interface CaptureCapabilities {
    /** HTTPS o localhost. Sin esto no hay captura posible. */
    secureContext: boolean;
    microphone: boolean;
    /** Audio de pestaña: solo Chrome/Edge de escritorio. */
    tabAudio: boolean;
}

export interface CaptureResult {
    mic?: Blob;
    tab?: Blob;
}

/** Niveles de entrada 0-1, para ver de un vistazo si una pista está muda. */
export interface CaptureLevels {
    mic: number;
    tab: number;
}

export interface AudioCapture {
    capabilities: CaptureCapabilities;
    state: CaptureState;
    error: string | null;
    /** Segundos grabados. */
    elapsedSec: number;
    levels: CaptureLevels;
    /** true si la pestaña lleva un rato sin sonar mientras se graba. */
    tabSilent: boolean;
    start: () => Promise<void>;
    stop: () => Promise<CaptureResult>;
    reset: () => void;
}

/** Formatos que produce MediaRecorder, por orden de preferencia. */
const MIME_CANDIDATES = ["audio/webm;codecs=opus", "audio/webm", ""];

/** Cada cuánto emite MediaRecorder un trozo. */
const TIMESLICE_MS = 15_000;

/** Nivel por debajo del cual se considera que una pista no suena. */
const SILENCE_THRESHOLD = 0.01;

function detectCapabilities(): CaptureCapabilities {
    const secure =
        typeof window !== "undefined" && window.isSecureContext === true;
    const devices =
        typeof navigator !== "undefined" ? navigator.mediaDevices : undefined;
    return {
        secureContext: secure,
        microphone: secure && typeof devices?.getUserMedia === "function",
        tabAudio: secure && typeof devices?.getDisplayMedia === "function",
    };
}

function pickMimeType(): string | undefined {
    if (typeof MediaRecorder === "undefined") {
        return undefined;
    }
    for (const candidate of MIME_CANDIDATES) {
        if (candidate === "") {
            return undefined;
        }
        if (MediaRecorder.isTypeSupported?.(candidate)) {
            return candidate;
        }
    }
    return undefined;
}

interface TrackRecorder {
    recorder: MediaRecorder;
    stream: MediaStream;
    chunks: Blob[];
}

export function useAudioCapture(): AudioCapture {
    const [capabilities] = useState<CaptureCapabilities>(detectCapabilities);
    const [state, setState] = useState<CaptureState>("idle");
    const [error, setError] = useState<string | null>(null);
    const [elapsedSec, setElapsedSec] = useState(0);
    const [levels, setLevels] = useState<CaptureLevels>({ mic: 0, tab: 0 });
    const [tabSilent, setTabSilent] = useState(false);

    const micRef = useRef<TrackRecorder | null>(null);
    const tabRef = useRef<TrackRecorder | null>(null);
    const audioContextRef = useRef<AudioContext | null>(null);
    const rafRef = useRef<number | null>(null);
    /**
     * El bucle de medidores se reprograma a sí mismo, así que cancelar el
     * frame pendiente no basta: si `teardown` cae justo mientras `tick` se
     * ejecuta, `tick` agenda otro y el bucle revive sobre un componente ya
     * desmontado. Esta bandera lo corta de raíz.
     */
    const meteringRef = useRef(false);
    const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
    const silentSinceRef = useRef<number>(0);

    /** Suelta TODO: pistas, grabadoras, AudioContext y temporizadores. */
    const teardown = useCallback(() => {
        for (const ref of [micRef, tabRef]) {
            const current = ref.current;
            if (!current) {
                continue;
            }
            if (current.recorder.state !== "inactive") {
                try {
                    current.recorder.stop();
                } catch {
                    /* ya parada */
                }
            }
            for (const track of current.stream.getTracks()) {
                track.stop();
            }
        }
        if (timerRef.current !== null) {
            clearInterval(timerRef.current);
            timerRef.current = null;
        }
        meteringRef.current = false;
        if (rafRef.current !== null) {
            cancelAnimationFrame(rafRef.current);
            rafRef.current = null;
        }
        void audioContextRef.current?.close().catch(() => undefined);
        audioContextRef.current = null;
    }, []);

    // Al desmontar no puede quedar ni un micrófono abierto.
    useEffect(() => teardown, [teardown]);

    // Cerrar la pestaña a mitad de entrevista pierde la grabación entera.
    useEffect(() => {
        if (state !== "recording") {
            return;
        }
        const warn = (event: BeforeUnloadEvent): void => {
            event.preventDefault();
            event.returnValue = "";
        };
        window.addEventListener("beforeunload", warn);
        return () => window.removeEventListener("beforeunload", warn);
    }, [state]);

    /** Medidor de nivel por pista: detectar en el minuto 1 que algo no suena. */
    const startMeters = useCallback(
        (streams: { mic?: MediaStream; tab?: MediaStream }) => {
            if (typeof AudioContext === "undefined") {
                return;
            }
            const context = new AudioContext();
            audioContextRef.current = context;
            const analysers: Partial<Record<"mic" | "tab", AnalyserNode>> = {};
            for (const key of ["mic", "tab"] as const) {
                const stream = streams[key];
                if (!stream || stream.getAudioTracks().length === 0) {
                    continue;
                }
                const analyser = context.createAnalyser();
                analyser.fftSize = 512;
                context.createMediaStreamSource(stream).connect(analyser);
                analysers[key] = analyser;
            }

            const buffer = new Uint8Array(256);
            const tick = (): void => {
                if (!meteringRef.current) {
                    return;
                }
                const next: CaptureLevels = { mic: 0, tab: 0 };
                for (const key of ["mic", "tab"] as const) {
                    const analyser = analysers[key];
                    if (!analyser) {
                        continue;
                    }
                    analyser.getByteTimeDomainData(buffer);
                    let peak = 0;
                    for (const value of buffer) {
                        peak = Math.max(peak, Math.abs(value - 128) / 128);
                    }
                    next[key] = peak;
                }
                setLevels(next);

                if (analysers.tab) {
                    if (next.tab > SILENCE_THRESHOLD) {
                        silentSinceRef.current = Date.now();
                        setTabSilent(false);
                    } else if (Date.now() - silentSinceRef.current > 30_000) {
                        setTabSilent(true);
                    }
                }
                rafRef.current = requestAnimationFrame(tick);
            };
            silentSinceRef.current = Date.now();
            meteringRef.current = true;
            rafRef.current = requestAnimationFrame(tick);
        },
        [],
    );

    function buildRecorder(stream: MediaStream): TrackRecorder {
        const mimeType = pickMimeType();
        const recorder = new MediaRecorder(
            stream,
            mimeType ? { mimeType, audioBitsPerSecond: 32_000 } : undefined,
        );
        const chunks: Blob[] = [];
        recorder.ondataavailable = (event: BlobEvent) => {
            if (event.data.size > 0) {
                chunks.push(event.data);
            }
        };
        recorder.start(TIMESLICE_MS);
        return { recorder, stream, chunks };
    }

    const start = useCallback(async () => {
        setError(null);
        setState("requesting");
        let micStream: MediaStream | undefined;
        let tabStream: MediaStream | undefined;

        try {
            if (capabilities.microphone) {
                // echoCancellation a propósito: quita del micro el audio de la
                // pestaña que sale por los altavoces, que si no se colaría
                // duplicado y con la etiqueta de hablante equivocada.
                micStream = await navigator.mediaDevices.getUserMedia({
                    audio: {
                        echoCancellation: true,
                        noiseSuppression: true,
                        autoGainControl: true,
                    },
                });
            }

            if (capabilities.tabAudio) {
                // `video: true` es OBLIGATORIO: Chrome no enseña la casilla de
                // "compartir el audio de la pestaña" en una petición solo-audio.
                const display = await navigator.mediaDevices.getDisplayMedia({
                    video: true,
                    audio: {
                        echoCancellation: false,
                        noiseSuppression: false,
                        autoGainControl: false,
                    },
                });
                // El vídeo se descarta en el acto: solo interesa el sonido.
                for (const track of display.getVideoTracks()) {
                    track.stop();
                    display.removeTrack(track);
                }
                if (display.getAudioTracks().length === 0) {
                    for (const track of display.getTracks()) {
                        track.stop();
                    }
                    throw new NoTabAudioError();
                }
                tabStream = display;
            }

            if (!micStream && !tabStream) {
                throw new Error("sin fuentes");
            }

            if (micStream) {
                micRef.current = buildRecorder(micStream);
            }
            if (tabStream) {
                tabRef.current = buildRecorder(tabStream);
            }

            startMeters({ mic: micStream, tab: tabStream });
            setElapsedSec(0);
            timerRef.current = setInterval(
                () => setElapsedSec((seconds) => seconds + 1),
                1000,
            );
            setState("recording");
        } catch (err) {
            for (const stream of [micStream, tabStream]) {
                for (const track of stream?.getTracks() ?? []) {
                    track.stop();
                }
            }
            micRef.current = null;
            tabRef.current = null;
            setState("idle");
            setError(describeCaptureError(err));
        }
    }, [capabilities, startMeters]);

    const stop = useCallback(async (): Promise<CaptureResult> => {
        const result: CaptureResult = {};
        const mimeType = pickMimeType() ?? "audio/webm";

        for (const [key, ref] of [
            ["mic", micRef],
            ["tab", tabRef],
        ] as const) {
            const current = ref.current;
            if (!current) {
                continue;
            }
            await new Promise<void>((resolve) => {
                if (current.recorder.state === "inactive") {
                    resolve();
                    return;
                }
                current.recorder.onstop = () => resolve();
                current.recorder.stop();
            });
            if (current.chunks.length > 0) {
                result[key] = new Blob(current.chunks, { type: mimeType });
            }
        }

        teardown();
        micRef.current = null;
        tabRef.current = null;
        setState("stopped");
        setLevels({ mic: 0, tab: 0 });
        return result;
    }, [teardown]);

    const reset = useCallback(() => {
        teardown();
        micRef.current = null;
        tabRef.current = null;
        setState("idle");
        setError(null);
        setElapsedSec(0);
        setTabSilent(false);
    }, [teardown]);

    return {
        capabilities,
        state,
        error,
        elapsedSec,
        levels,
        tabSilent,
        start,
        stop,
        reset,
    };
}

/** El usuario compartió la pestaña pero sin marcar la casilla del audio. */
class NoTabAudioError extends Error {
    constructor() {
        super("sin audio de pestaña");
        this.name = "NoTabAudioError";
    }
}

/**
 * Traduce el fallo a algo accionable. El caso de la casilla sin marcar tiene
 * mensaje propio porque es el que va a pasar la primera vez que alguien lo
 * use, y sin instrucción precisa se queda atascado.
 */
function describeCaptureError(error: unknown): string {
    if (error instanceof NoTabAudioError) {
        return (
            "Compartiste la pestaña pero sin su audio. Vuelve a intentarlo y, " +
            'en el selector, elige "Pestaña de Chrome" y marca abajo ' +
            '"Compartir también el audio de la pestaña".'
        );
    }
    if (error instanceof Error && error.name === "NotAllowedError") {
        return "Denegaste el permiso. Sin micrófono ni audio de la pestaña no se puede grabar.";
    }
    if (error instanceof Error && error.name === "NotFoundError") {
        return "No se encontró ningún micrófono en este equipo.";
    }
    return "No se pudo iniciar la grabación. Revisa los permisos del navegador.";
}

/** `754` → `12:34`. */
export function formatElapsed(seconds: number): string {
    const total = Math.max(0, Math.floor(seconds));
    return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(
        total % 60,
    ).padStart(2, "0")}`;
}
