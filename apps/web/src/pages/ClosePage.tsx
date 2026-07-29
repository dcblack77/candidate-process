import { useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api/client";
import { friendlyMessage } from "../api/errors";
import { ProcessPurgeResponseDTO } from "../api/types";
import { ErrorAlert, Spinner } from "../components/ui";
import { useProcess } from "../context/ProcessContext";

/**
 * Pantalla Cerrar proceso (§21/§17): doble confirmación en UI (checkbox +
 * escribir el nombre del rol) antes de POST /process/close, que borra
 * definitivamente todos los datos derivados. El backend además exige
 * confirmDelete: true.
 */
export function ClosePage() {
    const { process, loading, refresh } = useProcess();
    const [understood, setUnderstood] = useState(false);
    const [typedTitle, setTypedTitle] = useState("");
    const [closing, setClosing] = useState(false);
    const [error, setError] = useState<string | null>(null);
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
                <h1 className="page-title">Proceso cerrado</h1>
                <section className="card">
                    <div className="alert alert-success">
                        Proceso cerrado: los datos se han borrado
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
                <h1 className="page-title">Cerrar proceso</h1>
                <p className="muted">No hay ningún proceso activo.</p>
                <Link to="/">Volver a Inicio</Link>
            </>
        );
    }

    const titleMatches = typedTitle.trim() === process.roleTitle;
    const canClose = understood && titleMatches && !closing;

    async function handleClose() {
        setClosing(true);
        setError(null);
        try {
            const purge = await api.closeProcess();
            setResult(purge);
            await refresh();
        } catch (err) {
            setError(friendlyMessage(err));
        } finally {
            setClosing(false);
        }
    }

    return (
        <>
            <h1 className="page-title">Cerrar proceso</h1>
            <section className="card">
                <h2>1. Qué se va a borrar</h2>
                <p>
                    Cerrar el proceso <strong>{process.roleTitle}</strong>{" "}
                    borra definitivamente:
                </p>
                <ul>
                    <li>Todos los candidatos y sus resúmenes de CV.</li>
                    <li>Todas las puntuaciones y evidencias.</li>
                    <li>Todas las preguntas de entrevista.</li>
                    <li>Todas las notas privadas.</li>
                </ul>
                <p className="muted small">
                    Solo se conserva el registro de auditoría del cierre. Esta
                    acción no se puede deshacer.
                </p>
            </section>

            <section className="card">
                <h2>2. Exporta antes de borrar (recomendado)</h2>
                <p>
                    Si necesitas conservar un informe para tu líder, genera el
                    export ahora: después del cierre no habrá datos.
                </p>
                <Link to="/export">
                    <button>Ir a Exportar</button>
                </Link>
            </section>

            <section className="card">
                <h2>3. Confirmación</h2>
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
                <ErrorAlert message={error} />
                <button
                    className="danger"
                    onClick={handleClose}
                    disabled={!canClose}
                >
                    {closing ? "Cerrando…" : "Cerrar proceso y borrar datos"}
                </button>
            </section>
        </>
    );
}
