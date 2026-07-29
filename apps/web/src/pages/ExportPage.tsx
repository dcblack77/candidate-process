import { useState } from "react";
import { api } from "../api/client";
import { friendlyMessage } from "../api/errors";
import {
    DEFAULT_EXPORT_INCLUDE,
    ExportInclude,
    ExportResponseDTO,
} from "../api/types";
import { ErrorAlert, Spinner } from "../components/ui";

/** Etiquetas en español de cada sección exportable. */
const INCLUDE_LABELS: Record<keyof ExportInclude, string> = {
    ranking: "Ranking",
    scoresByCriterion: "Puntuaciones por criterio",
    summary: "Resumen profesional",
    strengths: "Fortalezas",
    risks: "Riesgos",
    questions: "Preguntas de entrevista",
    privateNotes: "Notas privadas",
    extractedText: "Texto extraído del CV",
};

/** Aclaración de qué cubre exactamente cada sección cuando no es obvio. */
const INCLUDE_HINTS: Partial<Record<keyof ExportInclude, string>> = {
    ranking:
        "la tabla con las tres columnas (CV, entrevista y score final combinado), la fórmula del score final y el aviso de los candidatos con score provisional",
    scoresByCriterion:
        "el peso y la nota de cada criterio, y el veredicto del contraste CV/entrevista (confirmado, no demostrado o contradicho)",
    privateNotes:
        "notas privadas del evaluador y notas de las respuestas de entrevista",
    questions:
        "las notas numéricas de las respuestas (1-10) salen siempre que se incluyan las preguntas",
};

/** Secciones sensibles: desmarcadas por defecto y con aviso al marcarlas. */
const SENSITIVE_KEYS: ReadonlyArray<keyof ExportInclude> = [
    "privateNotes",
    "extractedText",
];

/**
 * Pantalla Exportar (§21/§19): selección de secciones con los DEFAULTS
 * SEGUROS del backend, vista previa del Markdown y descarga local.
 */
export function ExportPage() {
    const [include, setInclude] = useState<ExportInclude>({
        ...DEFAULT_EXPORT_INCLUDE,
    });
    const [result, setResult] = useState<ExportResponseDTO | null>(null);
    const [generating, setGenerating] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const sensitiveChecked = SENSITIVE_KEYS.filter((key) => include[key]);

    function toggle(key: keyof ExportInclude) {
        setInclude((prev) => ({ ...prev, [key]: !prev[key] }));
    }

    async function handleGenerate() {
        setGenerating(true);
        setError(null);
        try {
            setResult(await api.exportReport(include));
        } catch (err) {
            setError(friendlyMessage(err));
        } finally {
            setGenerating(false);
        }
    }

    function handleDownload() {
        if (!result) {
            return;
        }
        const blob = new Blob([result.content], {
            type: "text/markdown;charset=utf-8",
        });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = result.filename;
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        URL.revokeObjectURL(url);
    }

    return (
        <>
            <h1 className="page-title">Exportar para el líder</h1>
            <section className="card">
                <h2>Qué incluir</h2>
                {(
                    Object.keys(DEFAULT_EXPORT_INCLUDE) as Array<
                        keyof ExportInclude
                    >
                ).map((key) => (
                    <div className="checkbox-row" key={key}>
                        <input
                            id={`include-${key}`}
                            type="checkbox"
                            checked={include[key]}
                            onChange={() => toggle(key)}
                        />
                        <label htmlFor={`include-${key}`}>
                            {INCLUDE_LABELS[key]}
                            {SENSITIVE_KEYS.includes(key) && (
                                <span className="muted small">
                                    {" "}
                                    (información sensible, excluida por
                                    defecto)
                                </span>
                            )}
                            {INCLUDE_HINTS[key] && (
                                <span className="muted small">
                                    {" "}
                                    — incluye {INCLUDE_HINTS[key]}
                                </span>
                            )}
                        </label>
                    </div>
                ))}
                {sensitiveChecked.length > 0 && (
                    <div className="alert alert-warning" role="alert">
                        Atención: has marcado secciones con información
                        sensible (
                        {sensitiveChecked
                            .map((key) => INCLUDE_LABELS[key])
                            .join(", ")}
                        ). El export las incluirá y la acción quedará
                        registrada en la auditoría. Compártelo solo si es
                        imprescindible.
                    </div>
                )}
                <ErrorAlert message={error} />
                <div className="actions-row">
                    <button
                        className="primary"
                        onClick={handleGenerate}
                        disabled={generating}
                    >
                        {generating ? (
                            <>
                                <Spinner /> Generando…
                            </>
                        ) : (
                            "Generar export"
                        )}
                    </button>
                    {result && (
                        <span className="muted small">
                            Exportaciones usadas: {result.exportsUsedThisSession}
                            /{result.exportsLimit}
                        </span>
                    )}
                </div>
            </section>

            {result && (
                <section className="card">
                    <h2>Vista previa ({result.filename})</h2>
                    <pre className="export-preview">{result.content}</pre>
                    <button className="primary" onClick={handleDownload}>
                        Descargar {result.filename}
                    </button>
                </section>
            )}
        </>
    );
}
