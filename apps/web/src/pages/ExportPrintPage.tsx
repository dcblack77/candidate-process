import { Link } from "react-router-dom";
import {
    CRITERIA,
    CRITERION_LABELS,
    Criterion,
    ExportCandidateDTO,
    ExportStructuredResponseDTO,
    ScoreWeightsDTO,
    Verdict,
    VERDICT_LABELS,
} from "../api/types";
import { usePrintExport } from "../context/PrintExportContext";

/**
 * Vista de impresión del export (§19/§21): maqueta en papel A4 los datos
 * ESTRUCTURADOS que devuelve `POST /export` con `format: "structured"`, para
 * que el usuario genere el PDF con "Imprimir → Guardar como PDF".
 *
 * SEGURIDAD (regla innegociable): aquí NO se renderiza markdown como HTML.
 * Todo el contenido —resúmenes, evidencias, riesgos, preguntas— viene del
 * modelo o del CV y podría traer sintaxis maliciosa (enlaces o imágenes de
 * exfiltración). Se pinta SIEMPRE con React desde datos estructurados, que
 * escapa el texto: nada de `dangerouslySetInnerHTML`, `innerHTML` ni
 * conversores markdown→HTML.
 *
 * El documento NO vuelve a llamar a la API: cada llamada consumiría otra de
 * las 10 exportaciones de la sesión (§16). Los datos llegan en memoria desde
 * la pantalla Exportar (ver PrintExportContext).
 */
export function ExportPrintPage() {
    const { document } = usePrintExport();

    if (!document) {
        return (
            <>
                <h1 className="page-title">Vista de impresión</h1>
                <section className="card">
                    <div className="alert alert-warning" role="alert">
                        No hay ningún export preparado para imprimir. Los datos
                        viven solo en memoria (no se guardan en el navegador),
                        así que se pierden al recargar la página.
                    </div>
                    <p>
                        Vuelve a <Link to="/export">Exportar</Link>, elige qué
                        incluir y pulsa «Ver como PDF».
                    </p>
                </section>
            </>
        );
    }

    return (
        <>
            {/* La barra no se imprime: solo existe en pantalla. */}
            <div className="print-toolbar actions-row">
                <button className="primary" onClick={() => window.print()}>
                    Imprimir / Guardar como PDF
                </button>
                <Link to="/export">Volver a Exportar</Link>
                <span className="muted small">
                    En el diálogo del navegador elige «Guardar como PDF»,
                    tamaño A4 y desactiva encabezados y pies de página.
                </span>
            </div>
            <div className="print-backdrop">
                <article className="print-sheet">
                    <PrintExportDocument data={document} />
                </article>
            </div>
        </>
    );
}

/**
 * Documento imprimible en sí (separado de la ruta para poder probarlo con un
 * fixture, sin router ni contexto).
 */
export function PrintExportDocument({
    data,
}: {
    data: ExportStructuredResponseDTO;
}) {
    const { include } = data;
    return (
        <>
            <header className="print-cover">
                <p className="print-kicker">Evaluación de candidatos</p>
                <h1 className="print-title">{data.roleTitle}</h1>
                {data.roleContext && (
                    <p className="print-context">{data.roleContext}</p>
                )}
                <dl className="print-meta">
                    <div>
                        <dt>Fecha de generación</dt>
                        <dd>{formatGeneratedAt(data.generatedAt)}</dd>
                    </div>
                    <div>
                        <dt>Candidatos evaluados</dt>
                        <dd>{data.entries.length}</dd>
                    </div>
                    <div>
                        <dt>Sin puntuar</dt>
                        <dd>{data.unscored.length}</dd>
                    </div>
                </dl>
                <p className="print-confidential">
                    Documento con datos personales — no redistribuir. Uso
                    interno del proceso de selección: el sistema propone, la
                    decisión de contratación es humana.
                </p>
                {include.privateNotes && (
                    <p className="print-private-warning" role="note">
                        Contiene información privada: notas del evaluador y
                        texto de las respuestas de entrevista. Compártelo solo
                        si es imprescindible.
                    </p>
                )}
            </header>

            {include.ranking && (
                <section className="print-section print-ranking">
                    <h2>Ranking</h2>
                    <table className="print-table">
                        <thead>
                            <tr>
                                <th>#</th>
                                <th>Candidato</th>
                                <th>CV (1-5)</th>
                                <th>Entrevista (/10)</th>
                                <th>Score final</th>
                                <th>Confianza</th>
                            </tr>
                        </thead>
                        <tbody>
                            {data.entries.map((entry) => (
                                <tr key={entry.position}>
                                    <td>{entry.position}</td>
                                    <td>
                                        {entry.name}
                                        {entry.needsManualReview &&
                                            " (revisión manual)"}
                                    </td>
                                    <td>{entry.cvScore.toFixed(2)}</td>
                                    <td>{formatInterview(entry.interview.overall)}</td>
                                    <td className="print-overall">
                                        {entry.overallScore.toFixed(2)}
                                        {entry.provisional && "*"}
                                    </td>
                                    <td>{formatConfidence(entry.confidence)}</td>
                                </tr>
                            ))}
                            {data.entries.length === 0 && (
                                <tr>
                                    <td colSpan={6}>
                                        Sin candidatos puntuados.
                                    </td>
                                </tr>
                            )}
                        </tbody>
                    </table>
                    <p className="print-note">
                        {scoreFormula(data.scoreWeights)}. Pesos de la rúbrica
                        (score de CV): {weightsLine(data.weights)}.
                    </p>
                    {data.entries.some((entry) => entry.provisional) && (
                        <p className="print-note">
                            * Score provisional: ese candidato aún no tiene
                            respuestas de entrevista puntuadas, así que su score
                            final es todavía solo el del CV.
                        </p>
                    )}
                </section>
            )}

            {data.entries.map((entry) => (
                <PrintCandidateCard
                    key={entry.position}
                    entry={entry}
                    data={data}
                />
            ))}

            {data.unscored.length > 0 && (
                <section className="print-section print-unscored">
                    <h2>Candidatos sin puntuar</h2>
                    <p className="print-note">
                        Fuera del ranking: aún no tienen las cinco notas de la
                        rúbrica.
                    </p>
                    <ul>
                        {data.unscored.map((name) => (
                            <li key={name}>{name}</li>
                        ))}
                    </ul>
                </section>
            )}
        </>
    );
}

/** Ficha de un candidato; empieza siempre en página nueva (CSS). */
function PrintCandidateCard({
    entry,
    data,
}: {
    entry: ExportCandidateDTO;
    data: ExportStructuredResponseDTO;
}) {
    const { include, weights } = data;
    return (
        <section className="print-section print-candidate">
            <h2>
                {entry.position}. {entry.name}
            </h2>
            <p className="print-scoreline">
                <strong>Score final {entry.overallScore.toFixed(2)}</strong>
                {entry.provisional && " (provisional: sin entrevista puntuada)"}{" "}
                — CV {entry.cvScore.toFixed(2)} · Entrevista{" "}
                {formatInterview(entry.interview.overall)}/10 · Confianza{" "}
                {formatConfidence(entry.confidence)}
            </p>
            {entry.needsManualReview && (
                <p className="print-note">
                    Empate no resuelto por los criterios de desempate: requiere
                    revisión manual.
                </p>
            )}

            {entry.scores && (
                <table className="print-table print-criteria">
                    <thead>
                        <tr>
                            <th>Criterio</th>
                            <th>Peso</th>
                            <th>Nota (1-5)</th>
                            <th>Contraste con la entrevista</th>
                        </tr>
                    </thead>
                    <tbody>
                        {CRITERIA.map((criterion) => (
                            <tr key={criterion}>
                                <td>{CRITERION_LABELS[criterion]}</td>
                                <td>{percent(weights[criterion])}</td>
                                <td>{entry.scores?.[criterion] ?? "—"}</td>
                                <td>
                                    {verdictLabel(
                                        entry.verdicts?.[criterion] ?? null,
                                    )}
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            )}

            {entry.summary && (
                <div className="print-block">
                    <h3>Resumen</h3>
                    <p>{entry.summary}</p>
                </div>
            )}

            {include.strengths && (
                <div className="print-block">
                    <h3>Fortalezas</h3>
                    <PrintList
                        items={entry.strengths}
                        empty="Sin evidencias explícitas destacadas."
                    />
                </div>
            )}

            {include.risks && (
                <div className="print-block">
                    <h3>Riesgos</h3>
                    <PrintList
                        items={entry.risks}
                        empty="Sin riesgos identificados."
                    />
                </div>
            )}

            {include.risks && entry.doubts.length > 0 && (
                <div className="print-block">
                    <h3>Dudas pendientes de validar</h3>
                    <PrintList items={entry.doubts} empty="" />
                </div>
            )}

            {entry.interview.answeredCount > 0 && (
                <div className="print-block">
                    <h3>Entrevista</h3>
                    <p>
                        Nota global{" "}
                        <strong>
                            {formatInterview(entry.interview.overall)}
                        </strong>
                        /10 ({entry.interview.answeredCount} de{" "}
                        {entry.interview.totalCount} respuestas puntuadas).
                    </p>
                    <ul>
                        {CRITERIA.flatMap((criterion) => {
                            const average = entry.interview.byCriterion[criterion];
                            return average
                                ? [
                                      <li key={criterion}>
                                          {CRITERION_LABELS[criterion]}:{" "}
                                          {average.average.toFixed(1)}/10 (
                                          {average.answered}{" "}
                                          {average.answered === 1
                                              ? "respuesta"
                                              : "respuestas"}
                                          )
                                      </li>,
                                  ]
                                : [];
                        })}
                    </ul>
                </div>
            )}

            {entry.questions.length > 0 && (
                <div className="print-block">
                    <h3>Preguntas recomendadas</h3>
                    <ul className="print-questions">
                        {entry.questions.map((question, index) => (
                            <li key={index}>
                                {question.question}
                                {question.answerScore !== null && (
                                    <span className="print-answer-score">
                                        {" "}
                                        — nota de la respuesta:{" "}
                                        {question.answerScore}/10
                                    </span>
                                )}
                                {/* Texto privado: doble comprobación (§17). */}
                                {include.privateNotes && question.answerNotes && (
                                    <div className="print-private">
                                        Respuesta anotada:{" "}
                                        {question.answerNotes}
                                    </div>
                                )}
                            </li>
                        ))}
                    </ul>
                </div>
            )}

            {include.privateNotes && entry.manualNotes && (
                <div className="print-block print-private">
                    <h3>Notas privadas del evaluador</h3>
                    <p>{entry.manualNotes}</p>
                </div>
            )}
        </section>
    );
}

/** Lista simple con texto alternativo cuando no hay elementos. */
function PrintList({ items, empty }: { items: string[]; empty: string }) {
    if (items.length === 0) {
        return empty ? <p className="print-note">{empty}</p> : null;
    }
    return (
        <ul>
            {items.map((item, index) => (
                <li key={index}>{item}</li>
            ))}
        </ul>
    );
}

/** Porcentaje entero de un peso que llega del backend (nunca hardcodeado). */
function percent(weight: number | undefined): string {
    return typeof weight === "number" ? `${Math.round(weight * 100)}%` : "—";
}

/** Fórmula del score final con los pesos del backend (§06). */
function scoreFormula(scoreWeights: ScoreWeightsDTO | undefined): string {
    return (
        `Score final = CV×${percent(scoreWeights?.cv)} + ` +
        `Entrevista×${percent(scoreWeights?.interview)} (nota /2, escala 1-5)`
    );
}

/** Línea con los pesos de la rúbrica, en el orden de los criterios. */
function weightsLine(weights: Record<Criterion, number>): string {
    return CRITERIA.map(
        (criterion) =>
            `${CRITERION_LABELS[criterion]} ${percent(weights[criterion])}`,
    ).join(", ");
}

function verdictLabel(verdict: Verdict | null): string {
    return verdict === null ? "—" : VERDICT_LABELS[verdict];
}

function formatInterview(overall: number | null): string {
    return overall === null ? "—" : overall.toFixed(1);
}

function formatConfidence(confidence: number | null): string {
    return confidence === null ? "—" : confidence.toFixed(2);
}

/**
 * Fecha legible en papel a partir del ISO del backend. Formateo manual (no
 * `toLocaleString`) para que el documento salga igual en cualquier equipo.
 */
function formatGeneratedAt(iso: string): string {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) {
        return iso;
    }
    const pad = (value: number) => String(value).padStart(2, "0");
    return (
        `${pad(date.getDate())}/${pad(date.getMonth() + 1)}/${date.getFullYear()}` +
        ` ${pad(date.getHours())}:${pad(date.getMinutes())}`
    );
}
