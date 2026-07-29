import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api/client";
import { friendlyMessage } from "../api/errors";
import {
    CRITERIA,
    CRITERION_LABELS,
    RankingEntryDTO,
    RankingResponseDTO,
    TieBreakLevel,
} from "../api/types";
import { ErrorAlert, Spinner, StatusBadge } from "../components/ui";

/**
 * Etiqueta en español del nivel de desempate aplicado (§15). El orden real
 * lo fija el backend en scoring/weights.ts: adaptabilidad → fundamentos →
 * producción → profundidad → stack → entrevista → confianza.
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
// #, candidato, score final, los criterios, entrevista y confianza.
const RANKING_COLUMN_COUNT = 5 + CRITERIA.length;

/**
 * Pantalla Comparativa (§21/§15): tabla por criterios con pesos visibles,
 * badges de desempate y revisión manual, dudas y preguntas clave
 * expandibles, y candidatos sin puntuar aparte.
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

    return (
        <>
            <h1 className="page-title">Comparativa</h1>
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
                                <th>Score final</th>
                                {CRITERIA.map((criterion) => (
                                    <th key={criterion}>
                                        {CRITERION_LABELS[criterion]}{" "}
                                        <span className="muted">
                                            (
                                            {Math.round(
                                                ranking.weights[criterion] *
                                                    100,
                                            )}
                                            %)
                                        </span>
                                    </th>
                                ))}
                                <th>
                                    Entrevista{" "}
                                    <span className="muted">
                                        (escala 1-10, fuera del score final)
                                    </span>
                                </th>
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
                    )}
                </td>
                <td>
                    <strong>{entry.finalScore.toFixed(2)}</strong>
                </td>
                {CRITERIA.map((criterion) => (
                    <td key={criterion}>{entry.scores[criterion]}</td>
                ))}
                <td className="interview-cell">
                    {entry.interviewScore == null
                        ? "—"
                        : `${entry.interviewScore.toFixed(1)}/10`}
                </td>
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
