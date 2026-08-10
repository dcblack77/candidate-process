import { useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api/client";
import { friendlyMessage } from "../api/errors";
import { ProcessPurgeResponseDTO } from "../api/types";
import { ErrorAlert, Spinner } from "../components/ui";
import { useProcess } from "../context/ProcessContext";

/**
 * Pantalla Archivar o borrar (§21/§17). Desde el multiproceso (2026-08-07)
 * son DOS acciones distintas:
 *
 * - **Archivar**: el proceso pasa a solo lectura conservando sus datos. Es
 *   reversible (Reabrir en Inicio) y por eso no pide doble confirmación.
 * - **Borrar**: purga definitiva. Mantiene la doble confirmación de siempre
 *   (checkbox + escribir el nombre del rol); el backend además exige
 *   `confirmDelete: true`.
 */
export function ClosePage() {
    const { process, readOnly, loading, refresh } = useProcess();
    const [understood, setUnderstood] = useState(false);
    const [typedTitle, setTypedTitle] = useState("");
    const [archiving, setArchiving] = useState(false);
    const [deleting, setDeleting] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [archived, setArchived] = useState(false);
    const [result, setResult] = useState<ProcessPurgeResponseDTO | null>(null);

    if (loading) {
        return (
            <p>
                <Spinner /> Cargando…
            </p>
        );
    }

    if (result) {
        return (
            <>
                <h1 className="page-title">Proceso borrado</h1>
                <section className="card">
                    <div className="alert alert-success">
                        Proceso borrado: los datos se han eliminado
                        definitivamente.
                    </div>
                    <ul>
                        <li>Candidatos borrados: {result.candidatesDeleted}</li>
                        <li>Puntuaciones borradas: {result.scoresDeleted}</li>
                        <li>Preguntas borradas: {result.questionsDeleted}</li>
                    </ul>
                    <Link to="/">
                        <button className="primary">Volver a Inicio</button>
                    </Link>
                </section>
            </>
        );
    }

    if (!process) {
        return (
            <>
                <h1 className="page-title">Archivar o borrar</h1>
                <p className="muted">No hay ningún proceso seleccionado.</p>
                <Link to="/">Volver a Inicio</Link>
            </>
        );
    }

    const titleMatches = typedTitle.trim() === process.roleTitle;
    const canDelete = understood && titleMatches && !deleting;

    async function handleArchive() {
        setArchiving(true);
        setError(null);
        try {
            await api.closeProcess();
            setArchived(true);
            await refresh();
        } catch (err) {
            setError(friendlyMessage(err));
        } finally {
            setArchiving(false);
        }
    }

    async function handleDelete() {
        if (!process) {
            return;
        }
        setDeleting(true);
        setError(null);
        try {
            const purge = await api.deleteProcess(process.id);
            setResult(purge);
            await refresh();
        } catch (err) {
            setError(friendlyMessage(err));
        } finally {
            setDeleting(false);
        }
    }

    return (
        <>
            <h1 className="page-title">Archivar o borrar</h1>
            <ErrorAlert message={error} />

            <section className="card">
                <h2>Archivar (recomendado)</h2>
                <p>
                    Archivar <strong>{process.roleTitle}</strong> lo deja en
                    solo lectura: los candidatos, puntuaciones, preguntas y
                    notas se <strong>conservan</strong> y podrás consultarlos y
                    exportarlos cuando quieras.
                </p>
                <p className="muted small">
                    No hace falta archivar para abrir otro proceso: puedes
                    tener varios en curso a la vez.
                </p>
                {archived || readOnly ? (
                    <div className="alert alert-success">
                        Este proceso ya está archivado. Puedes reabrirlo desde
                        Inicio.
                    </div>
                ) : (
                    <button onClick={handleArchive} disabled={archiving}>
                        {archiving ? "Archivando…" : "Archivar proceso"}
                    </button>
                )}
            </section>

            <section className="card">
                <h2>Borrar definitivamente</h2>
                <p>
                    Borrar el proceso <strong>{process.roleTitle}</strong>{" "}
                    elimina para siempre:
                </p>
                <ul>
                    <li>Todos los candidatos y sus resúmenes de CV.</li>
                    <li>Todas las puntuaciones y evidencias.</li>
                    <li>Todas las preguntas de entrevista.</li>
                    <li>Todas las notas privadas.</li>
                </ul>
                <p className="muted small">
                    Solo se conserva el registro de auditoría del borrado. Esta
                    acción no se puede deshacer.
                </p>
                <p>
                    Si necesitas conservar un informe para tu líder, genera el
                    export antes: <Link to="/export">Ir a Exportar</Link>.
                </p>

                <div className="checkbox-row">
                    <input
                        id="confirm-understood"
                        type="checkbox"
                        checked={understood}
                        onChange={(e) => setUnderstood(e.target.checked)}
                    />
                    <label htmlFor="confirm-understood">
                        Entiendo que se borrarán todos los datos
                    </label>
                </div>
                <div className="field">
                    <label htmlFor="confirm-title">
                        Escribe el nombre del rol para confirmar (
                        {process.roleTitle})
                    </label>
                    <input
                        id="confirm-title"
                        type="text"
                        value={typedTitle}
                        onChange={(e) => setTypedTitle(e.target.value)}
                        placeholder={process.roleTitle}
                    />
                </div>
                <button
                    className="danger"
                    onClick={handleDelete}
                    disabled={!canDelete}
                >
                    {deleting ? "Borrando…" : "Borrar proceso y sus datos"}
                </button>
            </section>
        </>
    );
}
