import {
    ChangeEvent,
    FormEvent,
    useCallback,
    useEffect,
    useRef,
    useState,
} from "react";
import { Link } from "react-router-dom";
import { api } from "../api/client";
import { friendlyMessage } from "../api/errors";
import { CandidateListItemDTO } from "../api/types";
import {
    ErrorAlert,
    formatDate,
    IN_PROGRESS_STATUSES,
    Spinner,
    StatusBadge,
} from "../components/ui";

/** Intervalo del polling mientras hay candidatos en extracting/analyzing. */
const POLL_INTERVAL_MS = 2500;

/**
 * Pantalla Candidatos (§21): tabla con estado de análisis, alta por nombre,
 * subida de CV, análisis, reintento y borrado con confirmación.
 */
export function CandidatesPage() {
    const [candidates, setCandidates] = useState<CandidateListItemDTO[] | null>(
        null,
    );
    const [listError, setListError] = useState<string | null>(null);

    const load = useCallback(async () => {
        try {
            setCandidates(await api.listCandidates());
            setListError(null);
        } catch (err) {
            setListError(friendlyMessage(err));
        }
    }, []);

    useEffect(() => {
        void load();
    }, [load]);

    // Polling ligero: solo mientras algún candidato esté en curso.
    const hasInProgress =
        candidates?.some((c) =>
            IN_PROGRESS_STATUSES.includes(c.analysisStatus),
        ) ?? false;

    useEffect(() => {
        if (!hasInProgress) {
            return;
        }
        const timer = setInterval(() => void load(), POLL_INTERVAL_MS);
        return () => clearInterval(timer);
    }, [hasInProgress, load]);

    return (
        <>
            <h1 className="page-title">Candidatos</h1>
            <AddCandidateForm onAdded={load} />
            <ErrorAlert message={listError} />
            {candidates === null ? (
                <p>
                    <Spinner /> Cargando candidatos…
                </p>
            ) : candidates.length === 0 ? (
                <p className="muted">
                    Aún no hay candidatos. Añade el primero por nombre.
                </p>
            ) : (
                <div className="table-wrap card">
                    <table>
                        <thead>
                            <tr>
                                <th>Nombre</th>
                                <th>Estado de análisis</th>
                                <th>Fecha de alta</th>
                                <th>Acciones</th>
                            </tr>
                        </thead>
                        <tbody>
                            {candidates.map((candidate) => (
                                <CandidateRow
                                    key={candidate.id}
                                    candidate={candidate}
                                    onChanged={load}
                                />
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
        </>
    );
}

function AddCandidateForm({ onAdded }: { onAdded: () => Promise<void> }) {
    const [name, setName] = useState("");
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);

    async function handleSubmit(event: FormEvent) {
        event.preventDefault();
        if (name.trim().length === 0) {
            setError("El nombre no puede estar vacío.");
            return;
        }
        setSubmitting(true);
        setError(null);
        try {
            await api.createCandidate(name.trim());
            setName("");
            await onAdded();
        } catch (err) {
            setError(friendlyMessage(err));
        } finally {
            setSubmitting(false);
        }
    }

    return (
        <section className="card">
            <form onSubmit={handleSubmit}>
                <div className="field-inline">
                    <div style={{ flex: 1 }}>
                        <label htmlFor="candidateName">Nuevo candidato</label>
                        <input
                            id="candidateName"
                            type="text"
                            value={name}
                            maxLength={200}
                            onChange={(e) => setName(e.target.value)}
                            placeholder="Nombre del candidato"
                        />
                    </div>
                    <button
                        className="primary"
                        type="submit"
                        disabled={submitting}
                    >
                        {submitting ? "Añadiendo…" : "Añadir"}
                    </button>
                </div>
                <ErrorAlert message={error} />
            </form>
        </section>
    );
}

function CandidateRow({
    candidate,
    onChanged,
}: {
    candidate: CandidateListItemDTO;
    onChanged: () => Promise<void>;
}) {
    const [busy, setBusy] = useState<null | "upload" | "analyze" | "delete">(
        null,
    );
    const [rowError, setRowError] = useState<string | null>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);

    const status = candidate.analysisStatus;
    const inProgress = IN_PROGRESS_STATUSES.includes(status);
    /** Analizar exige un resumen persistido (summarized/analyzed/failed). */
    const canAnalyze = ["summarized", "analyzed", "failed"].includes(status);

    async function run(
        kind: "upload" | "analyze" | "delete",
        action: () => Promise<unknown>,
    ) {
        setBusy(kind);
        setRowError(null);
        try {
            await action();
            await onChanged();
        } catch (err) {
            setRowError(friendlyMessage(err));
            // El estado del candidato puede haber cambiado (p. ej. failed).
            await onChanged();
        } finally {
            setBusy(null);
        }
    }

    function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
        const file = event.target.files?.[0];
        event.target.value = "";
        if (!file) {
            return;
        }
        void run("upload", () => api.extractCv(candidate.id, file));
    }

    function handleDelete() {
        const confirmed = window.confirm(
            `¿Borrar al candidato "${candidate.name}"? Esta acción no se puede deshacer desde la interfaz.`,
        );
        if (confirmed) {
            void run("delete", () => api.deleteCandidate(candidate.id));
        }
    }

    return (
        <tr>
            <td>
                <Link to={`/candidates/${candidate.id}`}>{candidate.name}</Link>
            </td>
            <td>
                <StatusBadge status={status} />
            </td>
            <td className="small muted">{formatDate(candidate.createdAt)}</td>
            <td>
                <div className="actions-row">
                    <input
                        ref={fileInputRef}
                        type="file"
                        accept=".pdf,.docx,.txt"
                        style={{ display: "none" }}
                        onChange={handleFileChange}
                        aria-label={`Archivo de CV para ${candidate.name}`}
                    />
                    <button
                        onClick={() => fileInputRef.current?.click()}
                        disabled={busy !== null || inProgress}
                    >
                        {busy === "upload" ? (
                            <>
                                <Spinner /> Subiendo…
                            </>
                        ) : (
                            "Subir CV"
                        )}
                    </button>
                    <button
                        onClick={() =>
                            void run("analyze", () =>
                                api.analyzeCandidate(candidate.id),
                            )
                        }
                        disabled={busy !== null || inProgress || !canAnalyze}
                        title={
                            canAnalyze
                                ? undefined
                                : "Sube primero un CV para poder analizar"
                        }
                    >
                        {busy === "analyze" ? (
                            <>
                                <Spinner /> Analizando…
                            </>
                        ) : status === "failed" ? (
                            "Reintentar"
                        ) : (
                            "Analizar"
                        )}
                    </button>
                    <button
                        className="danger"
                        onClick={handleDelete}
                        disabled={busy !== null}
                    >
                        {busy === "delete" ? "Borrando…" : "Borrar"}
                    </button>
                </div>
                <ErrorAlert message={rowError} />
            </td>
        </tr>
    );
}
