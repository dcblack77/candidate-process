import { FormEvent, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api/client";
import { friendlyMessage } from "../api/errors";
import { ErrorAlert, formatDate, Spinner } from "../components/ui";
import { useProcess } from "../context/ProcessContext";

/**
 * Pantalla Inicio (§21): sin proceso activo → formulario de creación;
 * con proceso → resumen y accesos a las demás pantallas.
 */
export function HomePage() {
    const { process, loading, error, refresh } = useProcess();

    if (loading) {
        return (
            <p>
                <Spinner /> Cargando…
            </p>
        );
    }

    return (
        <>
            <h1 className="page-title">Inicio</h1>
            <ErrorAlert message={error} />
            {process ? (
                <ProcessSummary />
            ) : (
                <CreateProcessForm onCreated={refresh} />
            )}
        </>
    );
}

function ProcessSummary() {
    const { process } = useProcess();
    if (!process) {
        return null;
    }
    return (
        <>
            <section className="card">
                <h2>Proceso activo: {process.roleTitle}</h2>
                {process.roleContext ? (
                    <p>{process.roleContext}</p>
                ) : (
                    <p className="muted">Sin contexto del rol.</p>
                )}
                <p className="muted small">
                    Creado el {formatDate(process.createdAt)}
                </p>
                <div className="actions-row">
                    <Link to="/candidates">
                        <button className="primary">Candidatos</button>
                    </Link>
                    <Link to="/ranking">
                        <button>Comparativa</button>
                    </Link>
                    <Link to="/export">
                        <button>Exportar</button>
                    </Link>
                    <Link to="/close">
                        <button className="danger">Cerrar proceso</button>
                    </Link>
                </div>
            </section>
        </>
    );
}

function CreateProcessForm({ onCreated }: { onCreated: () => Promise<void> }) {
    const [roleTitle, setRoleTitle] = useState("");
    const [roleContext, setRoleContext] = useState("");
    const [submitting, setSubmitting] = useState(false);
    const [formError, setFormError] = useState<string | null>(null);

    async function handleSubmit(event: FormEvent) {
        event.preventDefault();
        if (roleTitle.trim().length === 0) {
            setFormError("El título del rol es obligatorio.");
            return;
        }
        setSubmitting(true);
        setFormError(null);
        try {
            await api.createProcess({
                roleTitle: roleTitle.trim(),
                ...(roleContext.trim() ? { roleContext: roleContext.trim() } : {}),
            });
            await onCreated();
        } catch (err) {
            setFormError(friendlyMessage(err));
        } finally {
            setSubmitting(false);
        }
    }

    return (
        <section className="card">
            <h2>Crear proceso</h2>
            <p className="muted">
                No hay ningún proceso activo. Crea uno para un único rol
                técnico.
            </p>
            <form onSubmit={handleSubmit}>
                <div className="field">
                    <label htmlFor="roleTitle">Título del rol</label>
                    <input
                        id="roleTitle"
                        type="text"
                        value={roleTitle}
                        maxLength={200}
                        onChange={(e) => setRoleTitle(e.target.value)}
                        placeholder="p. ej. Backend Engineer (AWS/TypeScript)"
                    />
                </div>
                <div className="field">
                    <label htmlFor="roleContext">
                        Contexto del rol (opcional)
                    </label>
                    <textarea
                        id="roleContext"
                        rows={5}
                        value={roleContext}
                        onChange={(e) => setRoleContext(e.target.value)}
                        placeholder="Equipo, retos, stack, qué se espera del perfil…"
                    />
                </div>
                <ErrorAlert message={formError} />
                <button className="primary" type="submit" disabled={submitting}>
                    {submitting ? "Creando…" : "Crear proceso"}
                </button>
            </form>
        </section>
    );
}
