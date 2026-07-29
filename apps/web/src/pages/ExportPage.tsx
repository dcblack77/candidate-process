import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api/client";
import { friendlyMessage } from "../api/errors";
import {
    DEFAULT_EXPORT_INCLUDE,
    ExportInclude,
    ExportResponseDTO,
} from "../api/types";
import { ErrorAlert, Spinner } from "../components/ui";
import { usePrintExport } from "../context/PrintExportContext";

/** Etiquetas en español de cada sección exportable. */
const INCLUDE_LABELS: Record<keyof ExportInclude, string> = {
    ranking: "Ranking",
    scoresByCriterion: "Puntuaciones por criterio",
    summary: "Resumen profesional",
    strengths: "Fortalezas",
    risks: "Riesgos y dudas pendientes",
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
    risks: "los riesgos detectados y, en el PDF, las dudas pendientes de validar en entrevista",
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
 * SEGUROS del backend, vista previa del Markdown con descarga local y, como
 * alternativa, la vista de impresión del navegador para guardar un PDF.
 *
 * Cada generación (markdown o PDF) consume una de las 10 exportaciones de la
 * sesión (§16): el botón «Ver como PDF» llama UNA vez a la API y entrega los
 * datos a /export/print, que ya no vuelve a pedirlos.
 */
export function ExportPage() {
    const navigate = useNavigate();
    const { setDocument } = usePrintExport();
    const [include, setInclude] = useState<ExportInclude>({
        ...DEFAULT_EXPORT_INCLUDE,
    });
    const [result, setResult] = useState<ExportResponseDTO | null>(null);
    const [generating, setGenerating] = useState(false);
    const [preparingPrint, setPreparingPrint] = useState(false);
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

    /**
     * Genera el export estructurado y salta a la vista de impresión. No se
     * reutiliza el markdown: son formatos distintos de la misma llamada.
     */
    async function handlePrintView() {
        setPreparingPrint(true);
        setError(null);
        try {
            setDocument(await api.exportStructured(include));
            navigate("/export/print");
        } catch (err) {
            setError(friendlyMessage(err));
        } finally {
            setPreparingPrint(false);
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
                        disabled={generating || preparingPrint}
                    >
                        {generating ? (
                            <>
                                <Spinner /> Generando…
                            </>
                        ) : (
                            "Generar export"
                        )}
                    </button>
                    <button
                        onClick={handlePrintView}
                        disabled={generating || preparingPrint}
                    >
                        {preparingPrint ? (
                            <>
                                <Spinner /> Preparando…
                            </>
                        ) : (
                            "Ver como PDF"
                        )}
                    </button>
                    {result && (
                        <span className="muted small">
                            Exportaciones usadas: {result.exportsUsedThisSession}
                            /{result.exportsLimit}
                        </span>
                    )}
                </div>
                <p className="muted small">
                    «Generar export» prepara el Markdown (vista previa y
                    descarga). «Ver como PDF» abre la vista de impresión del
                    navegador con las mismas secciones: desde ahí, «Guardar como
                    PDF». Cada una cuenta como una exportación de la sesión.
                </p>
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
