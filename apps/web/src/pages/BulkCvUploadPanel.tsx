import { ChangeEvent, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api, ApiError } from "../api/client";
import { friendlyMessage } from "../api/errors";
import {
    BulkImportItemStatus,
    CvBulkImportItemDTO,
    CvBulkImportResponseDTO,
    MAX_BULK_CV_FILES,
    MAX_CV_MB,
} from "../api/types";
import { ErrorAlert, Spinner } from "../components/ui";

/** Intervalo del polling del lote mientras está en curso. */
const POLL_INTERVAL_MS = 2000;

const ACCEPTED_EXTENSIONS = [".pdf", ".docx", ".txt"];

/** Etiqueta en español de cada estado de archivo del lote. */
const ITEM_LABELS: Record<BulkImportItemStatus, string> = {
    rejected: "Formato no admitido",
    queued: "En cola",
    summarizing: "Resumiendo",
    summarized: "Resumen listo",
    failed: "Error",
    skipped: "Omitido (ya tenía CV)",
    cancelled: "Cancelado",
};

const ITEM_BADGE_CLASS: Record<BulkImportItemStatus, string> = {
    rejected: "badge-failed",
    queued: "badge-pending",
    summarizing: "badge-extracting",
    summarized: "badge-summarized",
    failed: "badge-failed",
    skipped: "badge-neutral",
    cancelled: "badge-neutral",
};

/** Motivo legible del fallo de un archivo concreto (nunca datos crudos). */
const ITEM_ERROR_LABELS: Record<string, string> = {
    INVALID_INPUT: "No se pudo leer el archivo. Súbelo de nuevo desde su fila.",
    LLM_UNAVAILABLE:
        "El modelo local no respondió. Arranca el modelo y sube el CV desde su fila.",
    PROCESS_CLOSED: "El proceso se archivó antes de resumirlo.",
    NOT_FOUND: "El candidato se borró antes de resumirlo.",
    UNSUPPORTED_MEDIA_TYPE: "Solo se admiten PDF, DOCX y TXT.",
};

interface SelectedFile {
    file: File;
    /** Nombre escrito por el usuario; vacío = se deduce del archivo. */
    name: string;
    /** Motivo por el que este archivo no puede ir en el lote. */
    problem: string | null;
}

function formatSize(bytes: number): string {
    if (bytes < 1024) {
        return `${bytes} B`;
    }
    if (bytes < 1024 * 1024) {
        return `${(bytes / 1024).toFixed(0)} KB`;
    }
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function inspect(file: File): SelectedFile {
    const lower = file.name.toLowerCase();
    let problem: string | null = null;
    if (!ACCEPTED_EXTENSIONS.some((ext) => lower.endsWith(ext))) {
        problem = "Formato no admitido (PDF, DOCX o TXT).";
    } else if (file.size > MAX_CV_MB * 1024 * 1024) {
        problem = `Supera los ${MAX_CV_MB} MB.`;
    }
    return { file, name: "", problem };
}

/**
 * Carga masiva de CVs (§16, 2026-08-15): varios archivos de golpe → un
 * candidato por archivo, con el nombre deducido del nombre del archivo salvo
 * que se escriba otro. La API responde enseguida con un job y el resumen con
 * el modelo sigue en segundo plano: aquí se hace polling y se refresca la
 * lista de candidatos en cada vuelta.
 */
export function BulkCvUploadPanel({
    onChanged,
}: {
    onChanged: () => Promise<void>;
}) {
    const [selected, setSelected] = useState<SelectedFile[]>([]);
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [job, setJob] = useState<CvBulkImportResponseDTO | null>(null);
    const [cancelling, setCancelling] = useState(false);
    const fileInputRef = useRef<HTMLInputElement>(null);

    // Polling del job mientras corre; cada vuelta refresca también la lista.
    const running = job?.status === "running";
    const jobId = job?.jobId ?? null;
    useEffect(() => {
        if (!running || !jobId) {
            return;
        }
        let stopped = false;
        const tick = async () => {
            try {
                const next = await api.getBulkCvImport(jobId);
                if (!stopped) {
                    setJob(next);
                }
            } catch (err) {
                if (!stopped) {
                    setError(friendlyMessage(err));
                    // Sin job al que preguntar (p. ej. reinicio del backend):
                    // se deja de hacer polling; la lista manda.
                    setJob((current) =>
                        current ? { ...current, status: "failed" } : current,
                    );
                }
            }
            await onChanged();
        };
        const timer = setInterval(() => void tick(), POLL_INTERVAL_MS);
        return () => {
            stopped = true;
            clearInterval(timer);
        };
    }, [running, jobId, onChanged]);

    function handleFilesChange(event: ChangeEvent<HTMLInputElement>) {
        const files = Array.from(event.target.files ?? []);
        event.target.value = "";
        if (files.length === 0) {
            return;
        }
        setError(null);
        setJob(null);
        setSelected((current) => {
            const merged = [...current, ...files.map(inspect)];
            if (merged.length > MAX_BULK_CV_FILES) {
                setError(
                    `Como mucho ${MAX_BULK_CV_FILES} archivos por lote: se han dejado los ${MAX_BULK_CV_FILES} primeros.`,
                );
            }
            return merged.slice(0, MAX_BULK_CV_FILES);
        });
    }

    function updateName(index: number, name: string) {
        setSelected((current) =>
            current.map((entry, at) =>
                at === index ? { ...entry, name } : entry,
            ),
        );
    }

    function removeFile(index: number) {
        setSelected((current) => current.filter((_, at) => at !== index));
    }

    const blocked = selected.filter((entry) => entry.problem !== null);
    const canSubmit =
        selected.length > 0 && blocked.length === 0 && !submitting && !running;

    async function handleSubmit() {
        if (!canSubmit) {
            return;
        }
        setSubmitting(true);
        setError(null);
        try {
            const started = await api.startBulkCvImport(
                selected.map((entry) => entry.file),
                selected.map((entry) =>
                    entry.name.trim().length > 0 ? entry.name.trim() : null,
                ),
            );
            setJob(started);
            setSelected([]);
            await onChanged();
        } catch (err) {
            // Los límites del lote traen un mensaje concreto del backend
            // (cuántos caben, cupo por hora): es más útil que el genérico.
            if (
                err instanceof ApiError &&
                (err.code === "LIMIT_EXCEEDED" || err.code === "RATE_LIMITED")
            ) {
                setError(err.message);
            } else {
                setError(friendlyMessage(err));
            }
        } finally {
            setSubmitting(false);
        }
    }

    async function handleCancel() {
        if (!job) {
            return;
        }
        setCancelling(true);
        try {
            setJob(await api.cancelBulkCvImport(job.jobId));
        } catch (err) {
            setError(friendlyMessage(err));
        } finally {
            setCancelling(false);
        }
    }

    return (
        <section className="card" aria-labelledby="bulkCvTitle">
            <h2 id="bulkCvTitle" style={{ marginTop: 0 }}>
                Carga masiva de CVs
            </h2>
            <p className="muted small">
                Selecciona hasta {MAX_BULK_CV_FILES} archivos PDF, DOCX o TXT
                (máx. {MAX_CV_MB} MB cada uno). Se crea un candidato por
                archivo. Si no escribes un nombre, se deduce del nombre del
                archivo (p. ej. «cv_ana-perez.pdf» → «Ana Perez»); podrás
                renombrarlo después. El archivo original se descarta en cuanto
                se extrae su texto.
            </p>
            <div className="actions-row">
                <input
                    ref={fileInputRef}
                    type="file"
                    multiple
                    accept={ACCEPTED_EXTENSIONS.join(",")}
                    style={{ display: "none" }}
                    onChange={handleFilesChange}
                    aria-label="Archivos de CV para la carga masiva"
                />
                <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={submitting || running}
                >
                    Elegir archivos…
                </button>
                {selected.length > 0 && (
                    <>
                        <button
                            type="button"
                            className="primary"
                            onClick={() => void handleSubmit()}
                            disabled={!canSubmit}
                        >
                            {submitting ? (
                                <>
                                    <Spinner /> Subiendo…
                                </>
                            ) : (
                                `Importar ${selected.length} CV${selected.length === 1 ? "" : "s"}`
                            )}
                        </button>
                        <button
                            type="button"
                            onClick={() => setSelected([])}
                            disabled={submitting}
                        >
                            Vaciar selección
                        </button>
                    </>
                )}
            </div>
            <ErrorAlert message={error} />
            {blocked.length > 0 && (
                <div className="alert alert-warning" role="alert">
                    Quita los archivos marcados antes de importar: un archivo de
                    más de {MAX_CV_MB} MB o con formato no admitido detiene el
                    lote entero.
                </div>
            )}

            {selected.length > 0 && (
                <div className="table-wrap">
                    <table>
                        <thead>
                            <tr>
                                <th>Archivo</th>
                                <th>Tamaño</th>
                                <th>Nombre del candidato</th>
                                <th />
                            </tr>
                        </thead>
                        <tbody>
                            {selected.map((entry, index) => (
                                <tr key={`${entry.file.name}-${index}`}>
                                    <td>
                                        {entry.file.name}
                                        {entry.problem && (
                                            <div className="small badge badge-failed">
                                                {entry.problem}
                                            </div>
                                        )}
                                    </td>
                                    <td className="small muted">
                                        {formatSize(entry.file.size)}
                                    </td>
                                    <td>
                                        <input
                                            type="text"
                                            value={entry.name}
                                            maxLength={200}
                                            placeholder="Se deduce del archivo"
                                            aria-label={`Nombre del candidato para ${entry.file.name}`}
                                            onChange={(e) =>
                                                updateName(
                                                    index,
                                                    e.target.value,
                                                )
                                            }
                                            disabled={submitting}
                                        />
                                    </td>
                                    <td>
                                        <button
                                            type="button"
                                            className="link-button"
                                            onClick={() => removeFile(index)}
                                            disabled={submitting}
                                            aria-label={`Quitar ${entry.file.name}`}
                                        >
                                            Quitar
                                        </button>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}

            {job && (
                <BulkJobView
                    job={job}
                    cancelling={cancelling}
                    onCancel={() => void handleCancel()}
                    onDismiss={() => setJob(null)}
                />
            )}
        </section>
    );
}

function BulkJobView({
    job,
    cancelling,
    onCancel,
    onDismiss,
}: {
    job: CvBulkImportResponseDTO;
    cancelling: boolean;
    onCancel: () => void;
    onDismiss: () => void;
}) {
    const { counts } = job;
    const attempted = counts.total - counts.rejected;
    const finished =
        counts.summarized + counts.failed + counts.skipped + counts.cancelled;
    const running = job.status === "running";

    return (
        <div style={{ marginTop: "1rem" }} data-testid="bulk-job">
            <div className="actions-row">
                <strong>
                    {running ? (
                        <>
                            <Spinner /> Resumiendo CVs: {finished} de{" "}
                            {attempted}
                            {job.cancelRequested ? " (cancelando…)" : ""}
                        </>
                    ) : job.status === "done" ? (
                        `Lote terminado: ${counts.summarized} de ${attempted} con resumen`
                    ) : job.status === "cancelled" ? (
                        `Lote cancelado: ${counts.summarized} con resumen, ${counts.cancelled} sin empezar`
                    ) : (
                        `Lote detenido: ${counts.summarized} con resumen`
                    )}
                </strong>
                {running && (
                    <button
                        type="button"
                        className="danger"
                        onClick={onCancel}
                        disabled={cancelling || job.cancelRequested}
                    >
                        {cancelling ? "Cancelando…" : "Cancelar lote"}
                    </button>
                )}
                {!running && (
                    <button type="button" onClick={onDismiss}>
                        Cerrar
                    </button>
                )}
            </div>
            {job.status === "failed" && job.errorCode === "LLM_UNAVAILABLE" && (
                <div className="alert alert-error" role="alert">
                    El modelo local dejó de responder y el lote se detuvo. Los
                    candidatos que faltaban están creados sin CV («Pendiente»):
                    arranca el modelo y sube su CV desde su fila, o bórralos.
                </div>
            )}
            {counts.rejected > 0 && (
                <div className="alert alert-warning" role="alert">
                    {counts.rejected}{" "}
                    {counts.rejected === 1
                        ? "archivo se rechazó por formato y no creó candidato."
                        : "archivos se rechazaron por formato y no crearon candidato."}
                </div>
            )}
            <div className="table-wrap">
                <table>
                    <thead>
                        <tr>
                            <th>#</th>
                            <th>Candidato</th>
                            <th>Estado</th>
                            <th>Detalle</th>
                        </tr>
                    </thead>
                    <tbody>
                        {job.items.map((item) => (
                            <BulkItemRow key={item.index} item={item} />
                        ))}
                    </tbody>
                </table>
            </div>
        </div>
    );
}

function BulkItemRow({ item }: { item: CvBulkImportItemDTO }) {
    const inProgress = item.status === "summarizing";
    return (
        <tr>
            <td className="small muted">{item.index + 1}</td>
            <td>
                {item.candidateId ? (
                    <Link to={`/candidates/${item.candidateId}`}>
                        {item.name}
                    </Link>
                ) : (
                    <span className="muted">—</span>
                )}
            </td>
            <td>
                <span
                    className={`badge ${ITEM_BADGE_CLASS[item.status]}`}
                    data-status={item.status}
                >
                    {inProgress ? (
                        <>
                            <Spinner /> {ITEM_LABELS[item.status]}
                        </>
                    ) : (
                        ITEM_LABELS[item.status]
                    )}
                </span>
            </td>
            <td className="small muted">
                {item.status === "summarizing" && item.llmWaits > 0
                    ? `Esperando al modelo (intento ${item.llmWaits + 1})…`
                    : item.errorCode
                      ? (ITEM_ERROR_LABELS[item.errorCode] ?? item.errorCode)
                      : item.status === "summarized" && item.truncated
                        ? "Texto recortado a 50.000 caracteres."
                        : ""}
            </td>
        </tr>
    );
}
