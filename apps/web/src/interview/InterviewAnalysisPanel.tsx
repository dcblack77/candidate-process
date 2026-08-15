import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError } from "../api/client";
import { friendlyMessage } from "../api/errors";
import { InterviewAnalysisDTO, PHASE_LABELS, RecordingDTO } from "../api/types";
import { ErrorAlert, Spinner } from "../components/ui";
import { SavedRecordings } from "./SavedRecordings";
import { formatElapsed, useAudioCapture } from "./useAudioCapture";

/**
 * Análisis del audio de una entrevista (§24).
 *
 * Dos formas de aportar el audio:
 *
 * - **Grabar** micrófono + pestaña de la videollamada, si el navegador lo
 *   permite (contexto seguro, o sea `localhost` o HTTPS).
 * - **Subir** un archivo, que funciona siempre.
 *
 * El servidor de desarrollo sirve HTTPS con certificado propio, así que
 * grabar también funciona desde la LAN. Si aun así se llega por HTTP en
 * claro, la pantalla no se rompe: enseña la dirección `https://` equivalente
 * y deja el camino de subir el archivo.
 *
 * El sistema propone; el evaluador aplica.
 *
 * Desde el 2026-08-10 el audio y la transcripción SÍ se guardan en el
 * servidor (§24): el análisis vivía solo en memoria y al caerse se perdía
 * todo, incluida la grabación. Lo que antes era una entrevista perdida ahora
 * es un botón de reintentar. A cambio, la pantalla tiene que enseñar siempre
 * qué hay guardado y permitir borrarlo.
 */

/** Cada cuánto se pregunta por el progreso del análisis. */
const POLL_MS = 2000;

/** La misma dirección que hay en la barra, pero cifrada. */
function secureOrigin(): string {
    return `https://${window.location.host}`;
}

/** Un job vivo es el que aún puede cambiar: esperando o corriendo. */
function isLive(status: InterviewAnalysisDTO["status"]): boolean {
    return status === "queued" || status === "running";
}

/**
 * Qué decirle al evaluador cuando el job falla. Los mensajes del backend de
 * este dominio son genéricos por construcción (§17: nunca llevan
 * transcripción), así que los que explican una situación —"la grabación se
 * borró", "ya estaban todas puntuadas"— se enseñan tal cual; los de
 * infraestructura se traducen a qué levantar.
 */
function failureMessage(job: InterviewAnalysisDTO): string {
    switch (job.error?.code) {
        case "STT_UNAVAILABLE":
            return "El servicio local de transcripción falló. Comprueba que el contenedor `voice-stt` esté levantado y reanaliza desde la grabación guardada.";
        case "LIMIT_EXCEEDED":
        case "NOT_FOUND":
            return job.error.message;
        default:
            return "El análisis de la entrevista falló. Revisa que el modelo local esté disponible y reanaliza desde la grabación guardada.";
    }
}

export function InterviewAnalysisPanel({
    candidateId,
    onFinished,
}: {
    candidateId: string;
    onFinished: () => Promise<void>;
}) {
    const capture = useAudioCapture();
    const [file, setFile] = useState<File | null>(null);
    const [job, setJob] = useState<InterviewAnalysisDTO | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [starting, setStarting] = useState(false);
    const [sttUp, setSttUp] = useState<boolean | null>(null);
    const [recordings, setRecordings] = useState<RecordingDTO[]>([]);
    const inputRef = useRef<HTMLInputElement>(null);

    const refreshRecordings = useCallback(async () => {
        try {
            const { recordings: list } = await api.listRecordings(candidateId);
            setRecordings(list);
        } catch {
            // Que no se pueda listar no debe impedir grabar: la lista es
            // información, no un paso del flujo.
        }
    }, [candidateId]);

    useEffect(() => {
        void refreshRecordings();
    }, [refreshRecordings]);

    // Se comprueba ANTES de que nadie grabe cincuenta minutos para que el
    // análisis falle al final por un contenedor caído.
    useEffect(() => {
        let cancelled = false;
        void api
            .health()
            .then((health) => !cancelled && setSttUp(health.stt))
            .catch(() => !cancelled && setSttUp(false));
        return () => {
            cancelled = true;
        };
    }, []);

    // Reenganche: si al entrar (o al recargar) hay un análisis vivo sobre
    // alguna grabación de este candidato, se retoma el sondeo. Antes del
    // 2026-08-15 recargar la página perdía el progreso de vista y la
    // grabación se enseñaba como "interrumpida" mientras seguía corriendo.
    useEffect(() => {
        if (job) {
            return;
        }
        const live = recordings.find((recording) => recording.activeJobId);
        if (!live?.activeJobId) {
            return;
        }
        let cancelled = false;
        void api
            .getInterviewAnalysis(candidateId, live.activeJobId)
            .then((current) => {
                if (!cancelled && isLive(current.status)) {
                    setJob(current);
                }
            })
            .catch(() => {
                // Si ya no existe, la lista de grabaciones lo dirá al
                // refrescarse: no hay nada que enganchar.
            });
        return () => {
            cancelled = true;
        };
    }, [job, recordings, candidateId]);

    // Sondeo mientras el análisis sigue vivo (en cola o corriendo).
    useEffect(() => {
        if (!job || !isLive(job.status)) {
            return;
        }
        const timer = setTimeout(() => {
            void (async () => {
                try {
                    const next = await api.getInterviewAnalysis(
                        candidateId,
                        job.jobId,
                    );
                    setJob(next);
                    if (!isLive(next.status)) {
                        // También al fallar: la grabación pasa a "el análisis
                        // falló" y desde ahí se reintenta.
                        await refreshRecordings();
                    }
                    if (next.status === "done") {
                        await onFinished();
                    }
                } catch (err) {
                    // Un 404 a mitad de sondeo es la firma de un reinicio del
                    // servidor: el job vivía en memoria y ya no está, pero la
                    // grabación sí, y desde ella se reanaliza.
                    setError(
                        err instanceof ApiError && err.code === "NOT_FOUND"
                            ? "El análisis se interrumpió (el servidor se reinició). La grabación sigue guardada: reanalízala desde la lista de abajo."
                            : friendlyMessage(err),
                    );
                    setJob(null);
                    await refreshRecordings();
                }
            })();
        }, POLL_MS);
        return () => clearTimeout(timer);
    }, [job, candidateId, onFinished, refreshRecordings]);

    const blocked = sttUp === false;
    const canRecord =
        capture.capabilities.microphone || capture.capabilities.tabAudio;
    const recording = capture.state === "recording";
    const running = job !== null && isLive(job.status);

    async function send(
        tracks: { mic?: Blob; tab?: Blob },
        candidateSource: "mic" | "tab",
    ) {
        setStarting(true);
        setError(null);
        try {
            setJob(
                await api.startInterviewAnalysis(candidateId, tracks, {
                    candidateSource,
                }),
            );
            // La grabación ya existe en el servidor aunque el análisis acabe
            // de empezar: que se vea desde el primer momento.
            await refreshRecordings();
        } catch (err) {
            setError(friendlyMessage(err));
        } finally {
            setStarting(false);
        }
    }

    /** Relanza el análisis sobre una grabación guardada. */
    async function handleResume(recordingId: string) {
        setStarting(true);
        setError(null);
        try {
            setJob(
                await api.resumeInterviewAnalysis(candidateId, recordingId, {
                    includeAnswered: false,
                }),
            );
        } catch (err) {
            setError(friendlyMessage(err));
        } finally {
            setStarting(false);
        }
    }

    async function handleDeleteRecording(recordingId: string) {
        // Borra audio de una persona real y no se deshace: se confirma.
        if (
            !window.confirm(
                "Se borrarán el audio y la transcripción de esta entrevista. No se puede deshacer. ¿Continuar?",
            )
        ) {
            return;
        }
        setError(null);
        try {
            await api.deleteRecording(candidateId, recordingId);
            await refreshRecordings();
        } catch (err) {
            setError(friendlyMessage(err));
        }
    }

    async function handleStopAndAnalyze() {
        const result = await capture.stop();
        if (!result.mic && !result.tab) {
            setError("No se grabó nada. Inténtalo de nuevo.");
            capture.reset();
            return;
        }
        // El candidato está al otro lado de la videollamada salvo que solo
        // haya micrófono (entrevista presencial).
        await send(result, result.tab ? "tab" : "mic");
        capture.reset();
    }

    async function handleUpload() {
        if (!file) {
            return;
        }
        await send({ tab: file }, "tab");
        setFile(null);
        if (inputRef.current) {
            inputRef.current.value = "";
        }
    }

    return (
        <div className="interview-analysis">
            <h3>Analizar el audio de la entrevista</h3>
            <p className="muted small">
                El sistema propondrá nota y notas para las preguntas sin
                puntuar, incluidas las que el candidato abordó sin que se lo
                preguntaras. Nada se aplica solo: revisas y decides. El audio y
                la transcripción quedan guardados en el servidor para poder
                reanalizar si algo falla.
            </p>

            {blocked && (
                <p className="alert alert-warning small" role="status">
                    El servicio local de transcripción no responde. Levántalo
                    con <code>docker compose --profile voice up -d</code> en
                    /opt/ai-server.
                </p>
            )}

            {running ? (
                <div className="analysis-progress">
                    {job.status === "queued" ? (
                        <>
                            <p>
                                <Spinner /> En cola
                                {job.queuePosition !== null &&
                                job.queuePosition > 1
                                    ? ` · ${job.queuePosition - 1} por delante`
                                    : " · es el siguiente"}
                            </p>
                            <p className="muted small">
                                Hay otro análisis de entrevista corriendo; este
                                arrancará solo cuando termine. Puedes salir de
                                esta pantalla: al volver se retoma el progreso.
                            </p>
                        </>
                    ) : (
                        <>
                            <p>
                                <Spinner /> {PHASE_LABELS[job.phase]} ·{" "}
                                {job.progress.done}/{job.progress.total}
                            </p>
                            <p className="muted small">
                                Puede tardar varios minutos. Mientras tanto el
                                modelo está ocupado: analizar o generar
                                preguntas irá lento. Puedes salir de esta
                                pantalla: al volver se retoma el progreso.
                            </p>
                        </>
                    )}
                    <button
                        onClick={() =>
                            void api
                                .cancelInterviewAnalysis(
                                    candidateId,
                                    job.jobId,
                                )
                                .then(setJob)
                                .catch((err) =>
                                    setError(friendlyMessage(err)),
                                )
                        }
                    >
                        Cancelar análisis
                    </button>
                </div>
            ) : recording ? (
                <RecordingBar
                    capture={capture}
                    onStop={() => void handleStopAndAnalyze()}
                    busy={starting}
                />
            ) : (
                <>
                    {canRecord ? (
                        <div className="actions-row">
                            <button
                                className="primary"
                                onClick={() => void capture.start()}
                                disabled={blocked || starting}
                            >
                                Grabar entrevista
                            </button>
                            <span className="muted small">
                                Se te pedirá el micrófono y, después, que
                                elijas la pestaña de la videollamada.
                                <strong>
                                    {" "}
                                    Marca «compartir el audio de la pestaña»
                                </strong>
                                .
                            </span>
                        </div>
                    ) : (
                        <p className="alert alert-warning small" role="status">
                            {capture.capabilities.secureContext ? (
                                "Este navegador no permite capturar el audio de una pestaña. En Chrome o Edge sí funciona; mientras tanto, sube el archivo."
                            ) : (
                                <>
                                    Estás en {window.location.origin} y el
                                    navegador solo da acceso al micrófono por
                                    HTTPS. Abre{" "}
                                    <a href={secureOrigin()}>
                                        {secureOrigin()}
                                    </a>
                                    : la primera vez avisará de que no conoce
                                    el certificado — «Avanzado» → «Continuar».
                                    O sube el archivo de audio.
                                </>
                            )}
                        </p>
                    )}

                    <p className="muted small upload-row">
                        <strong>Ojo con subir un archivo suelto:</strong> si
                        lleva toda la conversación en una sola pista, el
                        sistema no puede distinguir quién habla y podría tomar
                        por demostrado algo que en realidad preguntaste tú.
                        Grabando desde aquí sí quedan separados.
                    </p>
                    <div className="field-inline">
                        <div>
                            <label htmlFor="interview-audio">
                                …o sube una grabación
                            </label>
                            <input
                                id="interview-audio"
                                ref={inputRef}
                                type="file"
                                accept="audio/*,video/webm"
                                disabled={blocked}
                                onChange={(e) =>
                                    setFile(e.target.files?.[0] ?? null)
                                }
                            />
                        </div>
                        <button
                            onClick={() => void handleUpload()}
                            disabled={!file || starting || blocked}
                        >
                            {starting ? "Subiendo…" : "Analizar audio"}
                        </button>
                    </div>
                </>
            )}

            {capture.error && <ErrorAlert message={capture.error} />}

            {job?.status === "done" && (
                <p className="alert alert-success small" role="status">
                    Análisis terminado: {job.stats?.questionsAssessed ?? 0}{" "}
                    preguntas revisadas. Las propuestas aparecen en cada
                    pregunta.
                </p>
            )}
            {job?.status === "cancelled" && (
                <p className="muted small">Análisis cancelado.</p>
            )}
            {job?.status === "failed" && (
                <ErrorAlert message={failureMessage(job)} />
            )}
            <ErrorAlert message={error} />

            <SavedRecordings
                recordings={recordings}
                busy={running || starting || recording}
                onResume={(id) => void handleResume(id)}
                onDelete={(id) => void handleDeleteRecording(id)}
            />
        </div>
    );
}

/**
 * Barra de grabación. Los medidores de nivel están para detectar en el minuto
 * 1 que una pista está muda, no en el minuto 50 cuando ya no hay remedio.
 */
function RecordingBar({
    capture,
    onStop,
    busy,
}: {
    capture: ReturnType<typeof useAudioCapture>;
    onStop: () => void;
    busy: boolean;
}) {
    return (
        <div className="analysis-progress recording-bar">
            <p>
                <span className="rec-dot" aria-hidden="true" /> Grabando ·{" "}
                <strong>{formatElapsed(capture.elapsedSec)}</strong>
            </p>
            <div className="level-meters">
                {capture.capabilities.microphone && (
                    <LevelMeter label="Micrófono" value={capture.levels.mic} />
                )}
                {capture.capabilities.tabAudio && (
                    <LevelMeter label="Pestaña" value={capture.levels.tab} />
                )}
            </div>
            {capture.tabSilent && (
                <p className="alert alert-warning small" role="status">
                    La pestaña lleva un rato sin sonar. ¿Marcaste «compartir el
                    audio de la pestaña»?
                </p>
            )}
            <button className="primary" onClick={onStop} disabled={busy}>
                {busy ? "Subiendo…" : "Detener y analizar"}
            </button>
        </div>
    );
}

function LevelMeter({ label, value }: { label: string; value: number }) {
    const percent = Math.min(100, Math.round(value * 140));
    return (
        <div className="level-meter">
            <span className="muted small">{label}</span>
            <div
                className="level-bar"
                role="meter"
                aria-label={`Nivel de ${label}`}
                aria-valuenow={percent}
                aria-valuemin={0}
                aria-valuemax={100}
            >
                <div
                    className="level-fill"
                    style={{ width: `${percent}%` }}
                />
            </div>
        </div>
    );
}
