import { RecordingDTO } from "../api/types";

/**
 * Grabaciones de entrevista conservadas en el servidor (§24, 2026-08-10).
 *
 * Existe por un fallo concreto: el análisis vivía solo en memoria y cuando se
 * caía a medias se perdía también el audio, así que una entrevista que ya
 * había ocurrido se quedaba sin evaluar. Ahora se puede reintentar desde
 * aquí.
 *
 * La lista es además el ÚNICO sitio desde el que se ve que hay audio de una
 * persona real guardado, y el único desde el que se puede borrar: por eso
 * enseña siempre el tamaño y el botón de borrar, aunque todo haya ido bien.
 */

/** Bytes a algo legible. Las entrevistas se miden en decenas de MB. */
function formatBytes(bytes: number): string {
    if (bytes <= 0) {
        return "sin archivos";
    }
    const mb = bytes / (1024 * 1024);
    return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`;
}

/** Duración en mm:ss. `null` mientras no se haya transcrito. */
function formatDuration(seconds: number | null): string | null {
    if (seconds === null) {
        return null;
    }
    const total = Math.round(seconds);
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

function formatDate(iso: string): string {
    return new Date(iso).toLocaleString("es-ES", {
        day: "2-digit",
        month: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
    });
}

/**
 * Qué pasó con el último análisis. `running` sin job vivo es el caso que
 * motivó todo esto: el proceso murió y dejó la grabación a medias.
 */
function statusLabel(recording: RecordingDTO): {
    text: string;
    tone: "ok" | "warn";
} {
    switch (recording.lastStatus) {
        case "done":
            return { text: "Analizada", tone: "ok" };
        case "failed":
            return { text: "El análisis falló", tone: "warn" };
        case "cancelled":
            return { text: "Análisis cancelado", tone: "warn" };
        case "running":
            return { text: "Análisis interrumpido", tone: "warn" };
        default:
            return { text: "Sin analizar", tone: "warn" };
    }
}

export function SavedRecordings({
    recordings,
    busy,
    onResume,
    onDelete,
}: {
    recordings: RecordingDTO[];
    /** Hay un análisis en curso: no se puede lanzar otro ni borrar. */
    busy: boolean;
    onResume: (recordingId: string) => void;
    onDelete: (recordingId: string) => void;
}) {
    if (recordings.length === 0) {
        return null;
    }

    return (
        <div className="saved-recordings">
            <h4>Grabaciones guardadas</h4>
            <p className="muted small">
                El audio y la transcripción se conservan en el servidor para
                poder reanalizar sin repetir la entrevista. Son datos de una
                persona real: bórralos cuando ya no los necesites.
            </p>

            <ul className="recording-list">
                {recordings.map((recording) => {
                    const status = statusLabel(recording);
                    const duration = formatDuration(recording.durationSec);
                    const gone = recording.bytes === 0;
                    return (
                        <li key={recording.id} className="recording-item">
                            <div className="recording-meta">
                                <strong>{formatDate(recording.createdAt)}</strong>
                                <span
                                    className={
                                        status.tone === "ok"
                                            ? "badge badge-ok"
                                            : "badge badge-warn"
                                    }
                                >
                                    {status.text}
                                </span>
                                <span className="muted small">
                                    {duration ? `${duration} · ` : ""}
                                    {recording.tracks.length === 2
                                        ? "2 pistas"
                                        : "1 pista"}{" "}
                                    · {formatBytes(recording.bytes)}
                                </span>
                            </div>

                            {!recording.hasTranscript && !gone && (
                                <p className="muted small">
                                    Sin transcripción guardada: reanalizar
                                    volverá a transcribir el audio y tardará
                                    varios minutos.
                                </p>
                            )}
                            {gone && (
                                <p className="muted small">
                                    Sus archivos ya no están en disco. Solo
                                    queda esta entrada; bórrala.
                                </p>
                            )}

                            <div className="actions-row">
                                <button
                                    onClick={() => onResume(recording.id)}
                                    disabled={busy || gone}
                                >
                                    {recording.hasTranscript
                                        ? "Reanalizar (sin transcribir de nuevo)"
                                        : "Reanalizar"}
                                </button>
                                <button
                                    className="danger"
                                    onClick={() => onDelete(recording.id)}
                                    disabled={busy}
                                >
                                    Borrar grabación
                                </button>
                            </div>
                        </li>
                    );
                })}
            </ul>
        </div>
    );
}
