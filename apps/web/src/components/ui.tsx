import { AnalysisStatus } from "../api/types";

/**
 * Piezas de UI compartidas: badge de estado de análisis, spinner y alertas.
 */

/** Etiquetas en español de cada estado de análisis. */
export const STATUS_LABELS: Record<AnalysisStatus, string> = {
    pending: "Pendiente",
    extracting: "Extrayendo CV",
    summarized: "Resumen listo",
    analyzing: "Analizando",
    analyzed: "Analizado",
    failed: "Error",
};

/** Estados transitorios: muestran spinner y activan el polling. */
export const IN_PROGRESS_STATUSES: readonly AnalysisStatus[] = [
    "extracting",
    "analyzing",
];

export function Spinner() {
    return <span className="spinner" role="status" aria-label="Cargando" />;
}

export function StatusBadge({ status }: { status: AnalysisStatus }) {
    const inProgress = IN_PROGRESS_STATUSES.includes(status);
    return (
        <span className={`badge badge-${status}`} data-status={status}>
            {inProgress ? (
                <>
                    <Spinner /> {STATUS_LABELS[status]}
                </>
            ) : (
                STATUS_LABELS[status]
            )}
        </span>
    );
}

export function ErrorAlert({ message }: { message: string | null }) {
    if (!message) {
        return null;
    }
    return (
        <div className="alert alert-error" role="alert">
            {message}
        </div>
    );
}

/** Fecha ISO → representación local corta en español. */
export function formatDate(iso: string): string {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) {
        return iso;
    }
    return date.toLocaleString("es-ES", {
        dateStyle: "medium",
        timeStyle: "short",
    });
}
