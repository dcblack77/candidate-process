import { FormEvent, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api/client";
import { friendlyMessage } from "../api/errors";
import { ProcessResponseDTO } from "../api/types";
import { ErrorAlert, formatDate, Spinner } from "../components/ui";
import { useProcess } from "../context/ProcessContext";

/** Límite del contexto del rol, espejo de MAX_ROLE_CONTEXT_LENGTH del backend. */
const MAX_ROLE_CONTEXT_LENGTH = 10_000;

/**
 * Pantalla Inicio (§21): sin ningún proceso → formulario de creación; con
 * proceso → resumen (editable) del seleccionado, lista del resto para
 * cambiar de uno a otro y alta de procesos nuevos.
 */
export function HomePage() {
    const { process, processes, loading, error, refresh } = useProcess();
    const [creating, setCreating] = useState(false);

    if (loading) {
        return (
            <p>
                <Spinner /> Cargando…
            </p>
        );
    }

    const empty = processes.length === 0 && !process;

    return (
        <>
            <h1 className="page-title">Inicio</h1>
            <ErrorAlert message={error} />
            {empty || creating ? (
                <CreateProcessForm
                    first={empty}
                    onCreated={async () => {
                        await refresh();
                        setCreating(false);
                    }}
                    onCancel={empty ? undefined : () => setCreating(false)}
                />
            ) : (
                <>
                    <ProcessSummary />
                    <OtherProcesses onCreateNew={() => setCreating(true)} />
                </>
            )}
        </>
    );
}

function ProcessSummary() {
    const { process, readOnly, refresh } = useProcess();
    const [editing, setEditing] = useState(false);
    const [reopening, setReopening] = useState(false);
    const [actionError, setActionError] = useState<string | null>(null);
    if (!process) {
        return null;
    }
    if (editing) {
        return (
            <EditProcessForm
                process={process}
                onSaved={async () => {
                    await refresh();
                    setEditing(false);
                }}
                onCancel={() => setEditing(false)}
            />
        );
    }

    async function handleReopen() {
        if (!process) {
            return;
        }
        setReopening(true);
        setActionError(null);
        try {
            await api.reopenProcess(process.id);
            await refresh();
        } catch (err) {
            setActionError(friendlyMessage(err));
        } finally {
            setReopening(false);
        }
    }

    return (
        <section className="card">
            <h2>
                {readOnly ? "Proceso archivado" : "Proceso en curso"}:{" "}
                {process.roleTitle}
            </h2>
            {readOnly && (
                <div className="alert alert-warning">
                    Este proceso está archivado. Puedes consultar candidatos,
                    comparativa y exportar, pero no modificar nada. Reábrelo
                    para volver a trabajar en él.
                </div>
            )}
            {process.roleContext ? (
                <p>{process.roleContext}</p>
            ) : (
                <p className="muted">Sin contexto del rol.</p>
            )}
            <p className="muted small">
                Creado el {formatDate(process.createdAt)}
                {process.closedAt
                    ? ` · Archivado el ${formatDate(process.closedAt)}`
                    : ""}
            </p>
            <ErrorAlert message={actionError} />
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
                {readOnly ? (
                    <button onClick={handleReopen} disabled={reopening}>
                        {reopening ? "Reabriendo…" : "Reabrir proceso"}
                    </button>
                ) : (
                    <button onClick={() => setEditing(true)}>
                        Editar proceso
                    </button>
                )}
                <Link to="/close">
                    <button className="danger">Archivar o borrar</button>
                </Link>
            </div>
        </section>
    );
}

/**
 * Los demás procesos y el alta de uno nuevo. Cambiar de proceso aquí lo
 * cambia también para el resto de equipos: la selección vive en el servidor.
 */
function OtherProcesses({ onCreateNew }: { onCreateNew: () => void }) {
    const { processes, select } = useProcess();
    const others = processes.filter((p) => !p.isCurrent);

    return (
        <section className="card">
            <h2>Otros procesos</h2>
            {others.length === 0 ? (
                <p className="muted">
                    No hay más procesos. Puedes abrir otro sin cerrar este: los
                    datos de cada uno son independientes.
                </p>
            ) : (
                <>
                    <ul className="process-list">
                        {others.map((p) => (
                            <li key={p.id}>
                                <button
                                    className="link-button"
                                    onClick={() => void select(p.id)}
                                >
                                    {p.roleTitle}
                                </button>{" "}
                                <span className="muted small">
                                    {p.candidateCount}{" "}
                                    {p.candidateCount === 1
                                        ? "candidato"
                                        : "candidatos"}
                                    {p.status === "closed"
                                        ? " · archivado"
                                        : ""}{" "}
                                    · creado el {formatDate(p.createdAt)}
                                </span>
                            </li>
                        ))}
                    </ul>
                    <p className="muted small">
                        Cambiar de proceso afecta a todos los equipos que estén
                        usando la aplicación.
                    </p>
                </>
            )}
            <button className="primary" onClick={onCreateNew}>
                Abrir otro proceso
            </button>
        </section>
    );
}

function EditProcessForm({
    process,
    onSaved,
    onCancel,
}: {
    process: ProcessResponseDTO;
    onSaved: () => Promise<void>;
    onCancel: () => void;
}) {
    const [roleTitle, setRoleTitle] = useState(process.roleTitle);
    const [roleContext, setRoleContext] = useState(process.roleContext ?? "");
    const [saving, setSaving] = useState(false);
    const [formError, setFormError] = useState<string | null>(null);

    async function handleSubmit(event: FormEvent) {
        event.preventDefault();
        if (roleTitle.trim().length === 0) {
            setFormError("El título del rol es obligatorio.");
            return;
        }
        setSaving(true);
        setFormError(null);
        try {
            await api.updateProcess({
                roleTitle: roleTitle.trim(),
                roleContext: roleContext.trim() ? roleContext.trim() : null,
            });
            await onSaved();
        } catch (err) {
            setFormError(friendlyMessage(err));
        } finally {
            setSaving(false);
        }
    }

    return (
        <section className="card">
            <h2>Editar proceso</h2>
            <p className="muted">
                El contexto del rol se usa al resumir CVs, al puntuar y al
                generar preguntas de entrevista. Los análisis ya generados no
                se actualizan solos: re-analiza al candidato para aplicar el
                nuevo contexto.
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
                        maxLength={MAX_ROLE_CONTEXT_LENGTH}
                        onChange={(e) => setRoleContext(e.target.value)}
                        placeholder="Equipo, retos, stack, qué se espera del perfil…"
                    />
                </div>
                <ErrorAlert message={formError} />
                <div className="actions-row">
                    <button
                        className="primary"
                        type="submit"
                        disabled={saving}
                    >
                        {saving ? "Guardando…" : "Guardar cambios"}
                    </button>
                    <button type="button" onClick={onCancel} disabled={saving}>
                        Cancelar
                    </button>
                </div>
            </form>
        </section>
    );
}

function CreateProcessForm({
    first,
    onCreated,
    onCancel,
}: {
    /** true si es el primer proceso de la aplicación (no hay ninguno). */
    first: boolean;
    onCreated: () => Promise<void>;
    /** Ausente cuando no hay nada a lo que volver. */
    onCancel?: () => void;
}) {
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
            <h2>{first ? "Crear proceso" : "Abrir otro proceso"}</h2>
            <p className="muted">
                {first
                    ? "Todavía no hay ningún proceso. Crea uno para un rol técnico."
                    : "El proceso actual se queda como está: no se cierra ni se borra nada. El nuevo pasará a ser el proceso en curso."}
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
                        maxLength={MAX_ROLE_CONTEXT_LENGTH}
                        onChange={(e) => setRoleContext(e.target.value)}
                        placeholder="Equipo, retos, stack, qué se espera del perfil…"
                    />
                </div>
                <ErrorAlert message={formError} />
                <div className="actions-row">
                    <button
                        className="primary"
                        type="submit"
                        disabled={submitting}
                    >
                        {submitting
                            ? "Creando…"
                            : first
                              ? "Crear proceso"
                              : "Abrir proceso"}
                    </button>
                    {onCancel && (
                        <button
                            type="button"
                            onClick={onCancel}
                            disabled={submitting}
                        >
                            Cancelar
                        </button>
                    )}
                </div>
            </form>
        </section>
    );
}
