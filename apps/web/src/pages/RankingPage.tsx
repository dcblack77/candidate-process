import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api/client";
import { friendlyMessage } from "../api/errors";
import {
    CRITERIA,
    CRITERION_LABELS,
    RankingEntryDTO,
    RankingResponseDTO,
    ScoreWeightsDTO,
    TieBreakLevel,
} from "../api/types";
import { ErrorAlert, Spinner, StatusBadge } from "../components/ui";

/**
 * Etiqueta en español del nivel de desempate aplicado cuando dos candidatos
 * empatan en el score final combinado (§15). El orden real lo fija el backend
 * en scoring/weights.ts: adaptabilidad → fundamentos → producción →
 * profundidad → stack → entrevista → confianza.
 */
const TIE_BREAK_LABELS: Record<TieBreakLevel, string> = {
    adaptability: "Desempate: adaptabilidad",
    fundamentals: "Desempate: fundamentos",
    production: "Desempate: producción",
    depth: "Desempate: profundidad",
    stack: "Desempate: stack",
    interview: "Desempatado por entrevista",
    confidence: "Desempate: confianza",
};

/** Número de columnas de la tabla: usado por el colSpan de la fila expandible. */
// #, candidato, CV, entrevista, score final, los criterios y confianza.
const RANKING_COLUMN_COUNT = 6 + CRITERIA.length;

/**
 * Porcentaje entero de un peso (0-1) tal y como lo envía el backend. Devuelve
 * "—" si el peso no llega: preferimos no enseñar nada a inventar un número
 * que contradiga a `scoring/weights.ts`.
 */
function percent(weight: number | undefined): string {
    return typeof weight === "number" ? `${Math.round(weight * 100)}%` : "—";
}

/**
 * Fórmula del score final, construida SIEMPRE con los pesos que llegan del
 * backend (§06): si allí cambian, este texto cambia solo.
 */
function scoreFormula(scoreWeights: ScoreWeightsDTO | undefined): string {
    return (
        `Score final = CV×${percent(scoreWeights?.cv)} + ` +
        `Entrevista×${percent(scoreWeights?.interview)}`
    );
}

/**
 * Pantalla Comparativa (§21/§15/§06): tabla con los DOS niveles de score
 * —CV (lo que promete) y score final combinado (lo que demostró)—, pesos
 * visibles, badges de provisional/desempate/revisión manual, dudas y
 * preguntas clave expandibles, y candidatos sin puntuar aparte.
 */
export function RankingPage() {
    const [ranking, setRanking] = useState<RankingResponseDTO | null>(null);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        api.getRanking()
            .then((data) => {
                setRanking(data);
                setError(null);
            })
            .catch((err) => setError(friendlyMessage(err)));
    }, []);

    if (error) {
        return (
            <>
                <h1 className="page-title">Comparativa</h1>
                <ErrorAlert message={error} />
            </>
        );
    }
    if (!ranking) {
        return (
            <p>
                <Spinner /> Calculando ranking…
            </p>
        );
    }

    const hasProvisional = ranking.entries.some((entry) => entry.provisional);

    return (
        <>
            <h1 className="page-title">Comparativa</h1>
            <p className="score-formula">
                <strong>{scoreFormula(ranking.scoreWeights)}</strong>{" "}
                <span className="muted small">
                    — el <strong>CV</strong> (1-5) es lo que el candidato
                    promete; la <strong>entrevista</strong> (1-10, llevada a la
                    escala 1-5) es lo que demostró. El ranking se ordena por el
                    score final, así que un CV brillante sin entrevista sólida
                    puede quedar por debajo.
                </span>
            </p>
            {ranking.entries.length === 0 ? (
                <p className="muted">
                    Aún no hay candidatos con puntuación completa.
                </p>
            ) : (
                <div className="table-wrap card">
                    <table>
                        <thead>
                            <tr>
                                <th>#</th>
                                <th>Candidato</th>
                                <th>
                                    CV{" "}
                                    <span className="muted">
                                        (rúbrica 1-5,{" "}
                                        {percent(ranking.scoreWeights?.cv)} del
                                        final)
                                    </span>
                                </th>
                                <th>
                                    Entrevista{" "}
                                    <span className="muted">
                                        (escala 1-10,{" "}
                                        {percent(
                                            ranking.scoreWeights?.interview,
                                        )}{" "}
                                        del final)
                                    </span>
                                </th>
                                <th className="overall-header">
                                    Score final{" "}
                                    <span className="muted">
                                        (ordena el ranking)
                                    </span>
                                </th>
                                {CRITERIA.map((criterion) => (
                                    <th key={criterion}>
                                        {CRITERION_LABELS[criterion]}{" "}
                                        <span className="muted">
                                            ({percent(ranking.weights[criterion])}{" "}
                                            del CV)
                                        </span>
                                    </th>
                                ))}
                                <th>Confianza</th>
                            </tr>
                        </thead>
                        <tbody>
                            {ranking.entries.map((entry) => (
                                <RankingRow
                                    key={entry.candidateId}
                                    entry={entry}
                                />
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
            {hasProvisional && (
                <p className="muted small">
                    * Score <strong>provisional</strong>: ese candidato aún no
                    tiene respuestas de entrevista puntuadas, así que su score
                    final es todavía solo el del CV y no es comparable con el de
                    los ya entrevistados.
                </p>
            )}

            <section className="card">
                <h2>Candidatos sin puntuar</h2>
                {ranking.unscored.length === 0 ? (
                    <p className="muted">
                        Todos los candidatos tienen puntuación.
                    </p>
                ) : (
                    <ul>
                        {ranking.unscored.map((candidate) => (
                            <li key={candidate.candidateId}>
                                <Link
                                    to={`/candidates/${candidate.candidateId}`}
                                >
                                    {candidate.name}
                                </Link>{" "}
                                <StatusBadge
                                    status={candidate.analysisStatus}
                                />
                            </li>
                        ))}
                    </ul>
                )}
            </section>
        </>
    );
}

function RankingRow({ entry }: { entry: RankingEntryDTO }) {
    // Solo los criterios con alguna respuesta puntuada (el resto llega null).
    const interviewRows = CRITERIA.flatMap((criterion) => {
        const average = entry.interviewByCriterion?.[criterion];
        return average ? [{ criterion, average }] : [];
    });
    const hasDetails =
        entry.pendingDoubts.length > 0 ||
        entry.keyQuestions.length > 0 ||
        interviewRows.length > 0;
    return (
        <>
            <tr>
                <td>{entry.position}</td>
                <td>
                    <Link to={`/candidates/${entry.candidateId}`}>
                        {entry.name}
                    </Link>{" "}
                    {entry.tieBreakApplied && (
                        <span className="badge badge-neutral">
                            {TIE_BREAK_LABELS[entry.tieBreakApplied] ??
                                "Desempate aplicado"}
                        </span>
                    )}{" "}
                    {entry.needsManualReview && (
                        <span className="badge badge-warning">
                            Revisión manual
                        </span>
                    )}{" "}
                    {entry.provisional && (
                        <span className="badge badge-provisional">
                            Provisional · pendiente de entrevista
                        </span>
                    )}
                </td>
                <td className="cv-cell">{entry.cvScore.toFixed(2)}</td>
                <td className="interview-cell">
                    {entry.interviewScore == null
                        ? "—"
                        : `${entry.interviewScore.toFixed(1)}/10`}
                </td>
                {/* El score que ordena: destacado y con * si es provisional. */}
                <td className="overall-cell">
                    <strong className="overall-score">
                        {entry.overallScore.toFixed(2)}
                        {entry.provisional && "*"}
                    </strong>
                </td>
                {CRITERIA.map((criterion) => (
                    <td key={criterion}>{entry.scores[criterion]}</td>
                ))}
                <td>
                    {entry.confidence == null
                        ? "—"
                        : entry.confidence.toFixed(2)}
                </td>
            </tr>
            {hasDetails && (
                <tr>
                    <td
                        colSpan={RANKING_COLUMN_COUNT}
                        style={{ borderBottom: "none" }}
                    >
                        <details>
                            <summary className="small muted">
                                Dudas pendientes, preguntas clave y entrevista
                            </summary>
                            {interviewRows.length > 0 && (
                                <>
                                    <h3 className="small">
                                        Entrevista por criterio (1-10)
                                    </h3>
                                    <ul className="small">
                                        {interviewRows.map(
                                            ({ criterion, average }) => (
                                                <li key={criterion}>
                                                    {CRITERION_LABELS[criterion]}
                                                    : {average.average.toFixed(1)}
                                                    /10 ({average.answered}{" "}
                                                    {average.answered === 1
                                                        ? "respuesta"
                                                        : "respuestas"}
                                                    )
                                                </li>
                                            ),
                                        )}
                                    </ul>
                                </>
                            )}
                            {entry.pendingDoubts.length > 0 && (
                                <>
                                    <h3 className="small">Dudas pendientes</h3>
                                    <ul className="small">
                                        {entry.pendingDoubts.map((d, i) => (
                                            <li key={i}>{d}</li>
                                        ))}
                                    </ul>
                                </>
                            )}
                            {entry.keyQuestions.length > 0 && (
                                <>
                                    <h3 className="small">Preguntas clave</h3>
                                    <ul className="small">
                                        {entry.keyQuestions.map((q, i) => (
                                            <li key={i}>{q}</li>
                                        ))}
                                    </ul>
                                </>
                            )}
                        </details>
                    </td>
                </tr>
            )}
        </>
    );
}
