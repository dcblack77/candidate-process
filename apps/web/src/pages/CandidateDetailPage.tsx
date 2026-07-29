import { FormEvent, useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api } from "../api/client";
import { friendlyMessage } from "../api/errors";
import {
    AnswerQuestionBody,
    AnswerQuestionResponseDTO,
    CandidateDetailDTO,
    CandidateScoreDTO,
    CRITERIA,
    Criterion,
    CRITERION_LABELS,
    CvSummary,
    emptyInterviewSummary,
    EvidenceItem,
    EvidenceSummary,
    InterviewQuestionDTO,
    InterviewSummaryDTO,
    isAssessedVerdict,
    MAX_ANSWER_NOTES_LENGTH,
    MAX_ANSWER_SCORE,
    MIN_ANSWER_SCORE,
    Verdict,
    VERDICT_CLASSES,
    VERDICT_LABELS,
} from "../api/types";
import { EvidenceList } from "../components/EvidenceList";
import {
    ErrorAlert,
    formatDate,
    Spinner,
    StatusBadge,
} from "../components/ui";

/** Valores seleccionables de la nota de una respuesta: 1…10. */
const ANSWER_SCORE_VALUES: readonly number[] = Array.from(
    { length: MAX_ANSWER_SCORE - MIN_ANSWER_SCORE + 1 },
    (_, index) => MIN_ANSWER_SCORE + index,
);

/**
 * Pantalla Detalle de candidato (§21): resumen, evidencias por criterio
 * (explicit vs inferred), dudas y riesgos, puntuaciones editables,
 * preguntas de entrevista y notas privadas.
 */
export function CandidateDetailPage() {
    const { id } = useParams<{ id: string }>();
    const [candidate, setCandidate] = useState<CandidateDetailDTO | null>(null);
    const [error, setError] = useState<string | null>(null);

    const load = useCallback(async () => {
        if (!id) {
            return;
        }
        try {
            setCandidate(await api.getCandidate(id));
            setError(null);
        } catch (err) {
            setError(friendlyMessage(err));
        }
    }, [id]);

    useEffect(() => {
        void load();
    }, [load]);

    /**
     * Aplica la respuesta del PATCH de una respuesta de entrevista sin
     * recargar el candidato entero: sustituye la pregunta editada y adopta
     * los agregados ya recalculados por el backend (feedback inmediato).
     */
    const applyAnswer = useCallback((updated: AnswerQuestionResponseDTO) => {
        setCandidate((prev) =>
            prev === null
                ? prev
                : {
                      ...prev,
                      questions: prev.questions.map((question) =>
                          question.id === updated.question.id
                              ? updated.question
                              : question,
                      ),
                      interview: updated.interview,
                  },
        );
    }, []);

    if (error) {
        return (
            <>
                <ErrorAlert message={error} />
                <Link to="/candidates">Volver a candidatos</Link>
            </>
        );
    }
    if (!candidate || !id) {
        return (
            <p>
                <Spinner /> Cargando candidato…
            </p>
        );
    }

    const summary = parseCvSummary(candidate.cvSummary);
    const evidenceByCriterion = extractEvidence(candidate);
    const evidenceSummary = parseEvidenceSummary(
        candidate.score?.evidenceSummary,
    );
    const doubts =
        evidenceSummary?.doubts ?? summary?.doubts_for_interview ?? [];
    const risks = evidenceSummary?.risks ?? summary?.risks ?? [];
    const verdicts = extractVerdicts(candidate, evidenceSummary);
    // Análisis anterior al contraste CV/entrevista: hay respuestas puntuadas
    // pero ningún criterio las tuvo en cuenta (§13).
    const staleAnalysis =
        candidate.score !== null &&
        (candidate.interview?.answeredCount ?? 0) > 0 &&
        CRITERIA.every((criterion) => !isAssessedVerdict(verdicts[criterion]));

    return (
        <>
            <h1 className="page-title">
                {candidate.name}{" "}
                <StatusBadge status={candidate.analysisStatus} />
            </h1>
            <p className="small">
                <Link to="/candidates">← Volver a candidatos</Link>
            </p>

            <section className="card">
                <h2>Resumen profesional</h2>
                {summary ? (
                    <>
                        <p>{summary.professional_summary}</p>
                        {summary.technology_transitions.length > 0 && (
                            <>
                                <h3>Transiciones tecnológicas</h3>
                                <ul>
                                    {summary.technology_transitions.map(
                                        (t, i) => (
                                            <li key={i}>{t}</li>
                                        ),
                                    )}
                                </ul>
                            </>
                        )}
                    </>
                ) : (
                    <p className="muted">
                        Aún no hay resumen: sube un CV desde la pantalla de
                        candidatos.
                    </p>
                )}
            </section>

            <section className="card">
                <h2>Evidencias por criterio</h2>
                <p className="muted small">
                    Las evidencias <strong>explícitas</strong> aparecen en el
                    CV; las <em>inferidas</em> son deducciones del modelo y se
                    muestran atenuadas: valídalas en entrevista. El{" "}
                    <strong>veredicto</strong> de cada criterio contrasta lo que
                    prometía el CV con lo que se demostró en la entrevista.
                </p>
                {staleAnalysis && (
                    <p className="alert alert-warning small" role="status">
                        Este candidato ya tiene respuestas de entrevista
                        puntuadas, pero su análisis se hizo antes de
                        registrarlas: ningún criterio está contrastado. Vuelve a
                        analizarlo para que el modelo tenga en cuenta la
                        entrevista.
                    </p>
                )}
                {CRITERIA.map((criterion) => (
                    <div key={criterion}>
                        <h3>
                            {CRITERION_LABELS[criterion]}{" "}
                            {/* Sin análisis todavía no hay nada que contrastar. */}
                            {candidate.score !== null && (
                                <VerdictBadge verdict={verdicts[criterion]} />
                            )}
                        </h3>
                        {evidenceSummary?.criteria?.[criterion]?.rationale && (
                            <p className="small muted">
                                {evidenceSummary.criteria[criterion].rationale}
                            </p>
                        )}
                        <EvidenceList
                            items={evidenceByCriterion[criterion] ?? []}
                        />
                    </div>
                ))}
            </section>

            <section className="card">
                <h2>Dudas y riesgos</h2>
                <h3>Dudas para la entrevista</h3>
                {doubts.length > 0 ? (
                    <ul>
                        {doubts.map((d, i) => (
                            <li key={i}>{d}</li>
                        ))}
                    </ul>
                ) : (
                    <p className="muted small">Sin dudas registradas.</p>
                )}
                <h3>Riesgos</h3>
                {risks.length > 0 ? (
                    <ul>
                        {risks.map((r, i) => (
                            <li key={i}>{r}</li>
                        ))}
                    </ul>
                ) : (
                    <p className="muted small">Sin riesgos registrados.</p>
                )}
            </section>

            <ScoreEditor
                candidateId={id}
                score={candidate.score}
                onSaved={load}
            />
            <QuestionsSection
                candidateId={id}
                questions={candidate.questions}
                // Fallback defensivo: el backend siempre envía `interview`,
                // pero la UI no debe romperse si llega una respuesta parcial.
                interview={candidate.interview ?? emptyInterviewSummary()}
                onGenerated={load}
                onAnswered={applyAnswer}
            />
            <NotesSection
                candidateId={id}
                initialNotes={candidate.score?.manualNotes ?? ""}
            />
        </>
    );
}

// ── Veredicto del contraste CV/entrevista (§13) ────────────────────────────

/**
 * Badge del veredicto de un criterio. `null` se trata como `not_assessed`
 * (análisis antiguos, anteriores al contraste) y se muestra discreto: no es
 * una alerta, solo la ausencia de contraste.
 */
function VerdictBadge({ verdict }: { verdict: Verdict | null }) {
    const value: Verdict = verdict ?? "not_assessed";
    return (
        <span
            className={`badge ${VERDICT_CLASSES[value]}`}
            data-verdict={value}
            title="Contraste entre lo que prometía el CV y lo demostrado en la entrevista"
        >
            {VERDICT_LABELS[value]}
        </span>
    );
}

/**
 * Veredictos a mostrar: los que ya extrae el backend (`score.verdicts`) y,
 * como respaldo, los del propio `evidence_summary` por si llega una respuesta
 * antigua sin el campo derivado.
 */
function extractVerdicts(
    candidate: CandidateDetailDTO,
    evidenceSummary: EvidenceSummary | null,
): Record<Criterion, Verdict | null> {
    const result = {} as Record<Criterion, Verdict | null>;
    for (const criterion of CRITERIA) {
        result[criterion] =
            candidate.score?.verdicts?.[criterion] ??
            evidenceSummary?.criteria[criterion]?.verdict ??
            null;
    }
    return result;
}

// ── Parsers defensivos de columnas JSON (llegan como unknown) ──────────────

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseCvSummary(value: unknown): CvSummary | null {
    if (!isRecord(value) || typeof value.professional_summary !== "string") {
        return null;
    }
    const asList = (v: unknown): string[] =>
        Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : [];
    return {
        professional_summary: value.professional_summary,
        evidence: parseEvidenceMap(value.evidence),
        technology_transitions: asList(value.technology_transitions),
        doubts_for_interview: asList(value.doubts_for_interview),
        risks: asList(value.risks),
    };
}

function parseEvidenceItems(value: unknown): EvidenceItem[] {
    if (!Array.isArray(value)) {
        return [];
    }
    return value.filter(
        (item): item is EvidenceItem =>
            isRecord(item) &&
            typeof item.text === "string" &&
            (item.type === "explicit" || item.type === "inferred"),
    );
}

/** Veredicto persistido; null si falta o es un valor desconocido. */
function parseVerdict(value: unknown): Verdict | null {
    return typeof value === "string" && value in VERDICT_LABELS
        ? (value as Verdict)
        : null;
}

function parseEvidenceMap(value: unknown): Record<Criterion, EvidenceItem[]> {
    const map = {} as Record<Criterion, EvidenceItem[]>;
    for (const criterion of CRITERIA) {
        map[criterion] = isRecord(value)
            ? parseEvidenceItems(value[criterion])
            : [];
    }
    return map;
}

export function parseEvidenceSummary(value: unknown): EvidenceSummary | null {
    if (!isRecord(value) || !isRecord(value.criteria)) {
        return null;
    }
    const criteria = {} as EvidenceSummary["criteria"];
    for (const criterion of CRITERIA) {
        const entry = value.criteria[criterion];
        criteria[criterion] = {
            rationale:
                isRecord(entry) && typeof entry.rationale === "string"
                    ? entry.rationale
                    : "",
            evidence: isRecord(entry) ? parseEvidenceItems(entry.evidence) : [],
            verdict: isRecord(entry) ? parseVerdict(entry.verdict) : null,
        };
    }
    const asList = (v: unknown): string[] =>
        Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : [];
    return { criteria, doubts: asList(value.doubts), risks: asList(value.risks) };
}

/**
 * Evidencias a mostrar por criterio: las del análisis (evidence_summary) si
 * existen; si no, las del resumen del CV (cv_evidence / cvSummary.evidence).
 */
function extractEvidence(
    candidate: CandidateDetailDTO,
): Partial<Record<Criterion, EvidenceItem[]>> {
    const fromAnalysis = parseEvidenceSummary(candidate.score?.evidenceSummary);
    const result: Partial<Record<Criterion, EvidenceItem[]>> = {};
    const cvEvidence = isRecord(candidate.cvEvidence)
        ? parseEvidenceMap(candidate.cvEvidence)
        : parseCvSummary(candidate.cvSummary)?.evidence;
    for (const criterion of CRITERIA) {
        const analyzed = fromAnalysis?.criteria[criterion]?.evidence ?? [];
        result[criterion] =
            analyzed.length > 0 ? analyzed : (cvEvidence?.[criterion] ?? []);
    }
    return result;
}

// ── Puntuaciones editables ─────────────────────────────────────────────────

function ScoreEditor({
    candidateId,
    score,
    onSaved,
}: {
    candidateId: string;
    score: CandidateScoreDTO | null;
    onSaved: () => Promise<void>;
}) {
    const [values, setValues] = useState<Record<Criterion, string>>(() => {
        const initial = {} as Record<Criterion, string>;
        for (const criterion of CRITERIA) {
            const current = score?.scores[criterion];
            initial[criterion] = current == null ? "" : String(current);
        }
        return initial;
    });
    const [confidence, setConfidence] = useState(
        score?.confidence == null ? "" : String(score.confidence),
    );
    const [saving, setSaving] = useState(false);
    const [formError, setFormError] = useState<string | null>(null);
    const [savedScore, setSavedScore] = useState<CandidateScoreDTO | null>(
        score,
    );

    async function handleSubmit(event: FormEvent) {
        event.preventDefault();
        const patch: Partial<Record<Criterion, number>> = {};
        for (const criterion of CRITERIA) {
            const raw = values[criterion].trim();
            if (raw === "") {
                continue;
            }
            const parsed = Number(raw);
            if (!Number.isInteger(parsed) || parsed < 1 || parsed > 5) {
                setFormError(
                    `${CRITERION_LABELS[criterion]}: la puntuación debe ser un entero entre 1 y 5.`,
                );
                return;
            }
            patch[criterion] = parsed;
        }
        let confidenceValue: number | undefined;
        if (confidence.trim() !== "") {
            confidenceValue = Number(confidence);
            if (
                Number.isNaN(confidenceValue) ||
                confidenceValue < 0 ||
                confidenceValue > 1
            ) {
                setFormError("La confianza debe ser un número entre 0 y 1.");
                return;
            }
        }
        if (Object.keys(patch).length === 0 && confidenceValue === undefined) {
            setFormError("Introduce al menos una puntuación o la confianza.");
            return;
        }

        setSaving(true);
        setFormError(null);
        try {
            const updated = await api.patchScore(candidateId, {
                ...patch,
                ...(confidenceValue !== undefined
                    ? { confidence: confidenceValue }
                    : {}),
            });
            setSavedScore(updated);
            await onSaved();
        } catch (err) {
            setFormError(friendlyMessage(err));
        } finally {
            setSaving(false);
        }
    }

    return (
        <section className="card">
            <h2>Puntuaciones</h2>
            <ScoreOverview score={savedScore} />
            {/* noValidate: la validación 1-5 la hace la UI con mensajes propios. */}
            <form onSubmit={handleSubmit} noValidate>
                <div className="score-grid">
                    {CRITERIA.map((criterion) => (
                        <div key={criterion}>
                            <label htmlFor={`score-${criterion}`}>
                                {CRITERION_LABELS[criterion]} (1-5)
                            </label>
                            <input
                                id={`score-${criterion}`}
                                type="number"
                                min={1}
                                max={5}
                                step={1}
                                value={values[criterion]}
                                onChange={(e) =>
                                    setValues((prev) => ({
                                        ...prev,
                                        [criterion]: e.target.value,
                                    }))
                                }
                            />
                        </div>
                    ))}
                    <div>
                        <label htmlFor="score-confidence">
                            Confianza (0-1)
                        </label>
                        <input
                            id="score-confidence"
                            type="number"
                            min={0}
                            max={1}
                            step={0.05}
                            value={confidence}
                            onChange={(e) => setConfidence(e.target.value)}
                        />
                    </div>
                </div>
                <ErrorAlert message={formError} />
                <div className="actions-row">
                    <button
                        className="primary"
                        type="submit"
                        disabled={saving}
                    >
                        {saving ? "Guardando…" : "Guardar puntuaciones"}
                    </button>
                </div>
            </form>
        </section>
    );
}

/**
 * Los DOS niveles de score (§06) de un vistazo: lo que promete el CV, la nota
 * de entrevista y el combinado que ordena la comparativa. Los tres salen del
 * backend; la UI nunca los recalcula.
 */
function ScoreOverview({ score }: { score: CandidateScoreDTO | null }) {
    if (score === null || score.cvScore === null) {
        return (
            <p className="muted small">
                Aún no hay puntuaciones: analiza el candidato o rellena la
                rúbrica a mano.
            </p>
        );
    }
    return (
        <div className="score-overview" aria-label="Resumen de puntuaciones">
            <div className="score-box">
                <span className="score-box-value">
                    {score.cvScore.toFixed(2)}
                </span>
                <span className="score-box-scale">/5</span>
                <span className="score-box-caption muted small">
                    CV · lo que promete
                </span>
            </div>
            <span className="score-op" aria-hidden="true">
                +
            </span>
            <div className="score-box">
                <span className="score-box-value">
                    {score.interviewScore === null
                        ? "—"
                        : score.interviewScore.toFixed(1)}
                </span>
                <span className="score-box-scale">/10</span>
                <span className="score-box-caption muted small">
                    Entrevista · lo que demostró
                </span>
            </div>
            <span className="score-op" aria-hidden="true">
                =
            </span>
            <div className="score-box score-box-final">
                <span className="score-box-value final-score">
                    {score.overallScore === null
                        ? "—"
                        : score.overallScore.toFixed(2)}
                </span>
                <span className="score-box-scale">/5</span>
                <span className="score-box-caption muted small">
                    Score final · ordena la comparativa
                </span>
                {score.provisional && (
                    <span className="score-box-caption">
                        <span className="badge badge-provisional">
                            Provisional · pendiente de entrevista
                        </span>
                    </span>
                )}
            </div>
            <p className="muted small score-overview-note">
                El score final combina el CV con la nota de entrevista (llevada
                a escala 1-5). Sin respuestas puntuadas es todavía solo el score
                del CV, y por eso se marca como provisional.
            </p>
        </div>
    );
}

// ── Preguntas de entrevista ────────────────────────────────────────────────

function QuestionsSection({
    candidateId,
    questions,
    interview,
    onGenerated,
    onAnswered,
}: {
    candidateId: string;
    questions: InterviewQuestionDTO[];
    interview: InterviewSummaryDTO;
    onGenerated: () => Promise<void>;
    onAnswered: (updated: AnswerQuestionResponseDTO) => void;
}) {
    const [count, setCount] = useState("8");
    const [generating, setGenerating] = useState(false);
    const [error, setError] = useState<string | null>(null);

    async function handleGenerate() {
        const parsed = Number(count);
        if (!Number.isInteger(parsed) || parsed < 1 || parsed > 20) {
            setError("El número de preguntas debe ser un entero entre 1 y 20.");
            return;
        }
        setGenerating(true);
        setError(null);
        try {
            await api.generateQuestions(candidateId, parsed);
            await onGenerated();
        } catch (err) {
            setError(friendlyMessage(err));
        } finally {
            setGenerating(false);
        }
    }

    return (
        <section className="card">
            <h2>Preguntas de entrevista ({questions.length})</h2>
            <InterviewSummaryPanel interview={interview} />
            {questions.length === 0 && (
                <p className="muted">Aún no se han generado preguntas.</p>
            )}
            {questions.map((question) => (
                <QuestionBlock
                    key={question.id}
                    candidateId={candidateId}
                    question={question}
                    onAnswered={onAnswered}
                />
            ))}
            <div className="field-inline" style={{ marginTop: "0.75rem" }}>
                <div>
                    <label htmlFor="question-count">Cuántas generar</label>
                    <input
                        id="question-count"
                        type="number"
                        min={1}
                        max={20}
                        step={1}
                        value={count}
                        style={{ width: "6rem" }}
                        onChange={(e) => setCount(e.target.value)}
                    />
                </div>
                <button onClick={handleGenerate} disabled={generating}>
                    {generating ? (
                        <>
                            <Spinner /> Generando…
                        </>
                    ) : (
                        "Generar más preguntas"
                    )}
                </button>
            </div>
            <ErrorAlert message={error} />
        </section>
    );
}

/**
 * Panel de agregados de entrevista (§15). Se actualiza con el `interview`
 * que devuelve cada PATCH, sin recargar el candidato.
 */
function InterviewSummaryPanel({
    interview,
}: {
    interview: InterviewSummaryDTO;
}) {
    return (
        <div className="interview-summary" aria-label="Resumen de entrevista">
            <div className="interview-overall">
                <span className="interview-overall-value">
                    {interview.overall === null
                        ? "—"
                        : interview.overall.toFixed(1)}
                </span>
                <span className="interview-overall-scale">/10</span>
                <span className="interview-overall-caption muted small">
                    Nota de entrevista
                </span>
                <span className="interview-overall-caption muted small">
                    {interview.answeredCount}/{interview.totalCount} preguntas
                    puntuadas
                </span>
            </div>
            <table className="interview-table">
                <caption className="small muted">
                    Media por criterio (escala 1-10; 10 = la respuesta que más
                    se ajusta a lo esperado). No cambia el score del CV, pero es
                    la parte con más peso del score final (§06).
                </caption>
                <thead>
                    <tr>
                        <th>Criterio</th>
                        <th>Media</th>
                        <th>Respuestas</th>
                    </tr>
                </thead>
                <tbody>
                    {CRITERIA.map((criterion) => {
                        const entry = interview.byCriterion[criterion];
                        return (
                            <tr key={criterion}>
                                <td>{CRITERION_LABELS[criterion]}</td>
                                <td>
                                    {entry === null
                                        ? "—"
                                        : `${entry.average.toFixed(1)}/10`}
                                </td>
                                <td>{entry === null ? "—" : entry.answered}</td>
                            </tr>
                        );
                    })}
                </tbody>
            </table>
        </div>
    );
}

/**
 * Registro de la respuesta a una pregunta: nota 1-10 y notas privadas.
 *
 * DECISIONES DE USO EN VIVO (se rellena DURANTE la entrevista):
 * - La nota es una fila de 10 botones: un clic, sin teclado ni foco previo,
 *   y el valor elegido queda resaltado. Un input numérico obligaría a
 *   enfocar, teclear y confirmar.
 * - Las notas de texto se guardan con botón explícito (o Ctrl/Cmd+Enter):
 *   un autoguardado con debounce dispararía PATCH a media frase y cada
 *   PATCH recalcula los agregados, lo que produciría parpadeo del panel.
 */
function AnswerEditor({
    candidateId,
    question,
    onAnswered,
}: {
    candidateId: string;
    question: InterviewQuestionDTO;
    onAnswered: (updated: AnswerQuestionResponseDTO) => void;
}) {
    const savedNotes = question.answerNotes ?? "";
    const [notes, setNotes] = useState(savedNotes);
    const [pending, setPending] = useState<"score" | "notes" | null>(null);
    const [error, setError] = useState<string | null>(null);

    const notesDirty = notes !== savedNotes;

    async function send(body: AnswerQuestionBody, kind: "score" | "notes") {
        setPending(kind);
        setError(null);
        try {
            onAnswered(await api.answerQuestion(candidateId, question.id, body));
        } catch (err) {
            setError(friendlyMessage(err));
        } finally {
            setPending(null);
        }
    }

    const notesFieldId = `answer-notes-${question.id}`;

    return (
        <div className="answer-editor">
            <div
                className="answer-score"
                role="group"
                aria-label="Nota de la respuesta (1-10)"
            >
                <span className="answer-score-label">
                    Nota de la respuesta{" "}
                    <span className="muted small">
                        (1-10; 10 = la más ajustada a lo esperado)
                    </span>
                </span>
                <div className="answer-score-row">
                    {ANSWER_SCORE_VALUES.map((value) => {
                        const selected = question.answerScore === value;
                        return (
                            <button
                                key={value}
                                type="button"
                                className={
                                    selected
                                        ? "answer-score-btn selected"
                                        : "answer-score-btn"
                                }
                                aria-pressed={selected}
                                title={`Puntuar la respuesta con ${value} de 10`}
                                disabled={pending !== null}
                                onClick={() =>
                                    void send({ score: value }, "score")
                                }
                            >
                                {value}
                            </button>
                        );
                    })}
                    <button
                        type="button"
                        className="link-like"
                        disabled={
                            pending !== null || question.answerScore === null
                        }
                        onClick={() => void send({ score: null }, "score")}
                    >
                        Borrar nota
                    </button>
                </div>
            </div>

            <div className="field">
                <label htmlFor={notesFieldId}>Notas de la respuesta</label>
                <textarea
                    id={notesFieldId}
                    rows={3}
                    maxLength={MAX_ANSWER_NOTES_LENGTH}
                    placeholder="Qué respondió, señales observadas…"
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    onKeyDown={(e) => {
                        // Atajo para no soltar el teclado durante la entrevista.
                        if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                            e.preventDefault();
                            void send({ notes }, "notes");
                        }
                    }}
                />
                <p className="muted small">
                    Información <strong>privada</strong>: no se incluye en el
                    export por defecto (solo si marcas «Notas privadas» al
                    exportar).
                </p>
                <div className="actions-row">
                    <button
                        type="button"
                        disabled={pending !== null || !notesDirty}
                        onClick={() => void send({ notes }, "notes")}
                    >
                        {pending === "notes"
                            ? "Guardando…"
                            : "Guardar notas de la respuesta"}
                    </button>
                    {notesDirty ? (
                        <span className="muted small">Sin guardar</span>
                    ) : (
                        savedNotes !== "" && (
                            <span className="muted small">Notas guardadas.</span>
                        )
                    )}
                </div>
            </div>
            <ErrorAlert message={error} />
        </div>
    );
}

/** Bloque completo de §14, colapsable por pregunta. */
function QuestionBlock({
    candidateId,
    question,
    onAnswered,
}: {
    candidateId: string;
    question: InterviewQuestionDTO;
    onAnswered: (updated: AnswerQuestionResponseDTO) => void;
}) {
    return (
        <details className="question">
            <summary>
                {question.question}{" "}
                {question.answerScore !== null && (
                    <span className="badge badge-answered">
                        Respondida · {question.answerScore}/10
                        {question.answeredAt !== null &&
                            ` · ${formatDate(question.answeredAt)}`}
                    </span>
                )}
            </summary>
            <div className="question-body">
                <AnswerEditor
                    candidateId={candidateId}
                    question={question}
                    onAnswered={onAnswered}
                />
                <dl>
                    <dt>Dimensión</dt>
                    <dd>{question.dimension}</dd>
                    <dt>Criterio</dt>
                    <dd>{question.criterion}</dd>
                    {question.validates && (
                        <>
                            <dt>Qué valida</dt>
                            <dd>{question.validates}</dd>
                        </>
                    )}
                    {question.idealAnswer && (
                        <>
                            <dt>Respuesta ideal</dt>
                            <dd>{question.idealAnswer}</dd>
                        </>
                    )}
                    {question.positiveSignals.length > 0 && (
                        <>
                            <dt>Señales positivas</dt>
                            <dd>
                                <ul>
                                    {question.positiveSignals.map((s, i) => (
                                        <li key={i}>{s}</li>
                                    ))}
                                </ul>
                            </dd>
                        </>
                    )}
                    {question.warningSignals.length > 0 && (
                        <>
                            <dt>Señales de alerta</dt>
                            <dd>
                                <ul>
                                    {question.warningSignals.map((s, i) => (
                                        <li key={i}>{s}</li>
                                    ))}
                                </ul>
                            </dd>
                        </>
                    )}
                    {question.scoringGuidance && (
                        <>
                            <dt>Cómo puntuar</dt>
                            <dd>{question.scoringGuidance}</dd>
                        </>
                    )}
                </dl>
            </div>
        </details>
    );
}

// ── Notas privadas ─────────────────────────────────────────────────────────

function NotesSection({
    candidateId,
    initialNotes,
}: {
    candidateId: string;
    initialNotes: string;
}) {
    const [notes, setNotes] = useState(initialNotes);
    const [saving, setSaving] = useState(false);
    const [saved, setSaved] = useState(false);
    const [error, setError] = useState<string | null>(null);

    async function handleSave() {
        setSaving(true);
        setError(null);
        setSaved(false);
        try {
            await api.addNote(candidateId, notes);
            setSaved(true);
        } catch (err) {
            setError(friendlyMessage(err));
        } finally {
            setSaving(false);
        }
    }

    return (
        <section className="card">
            <h2>Notas privadas</h2>
            <p className="muted small">
                Las notas nunca se incluyen en los exports por defecto.
            </p>
            <div className="field">
                <textarea
                    aria-label="Notas privadas"
                    rows={5}
                    value={notes}
                    onChange={(e) => {
                        setNotes(e.target.value);
                        setSaved(false);
                    }}
                />
            </div>
            <ErrorAlert message={error} />
            {saved && (
                <div className="alert alert-success">Notas guardadas.</div>
            )}
            <button className="primary" onClick={handleSave} disabled={saving}>
                {saving ? "Guardando…" : "Guardar notas"}
            </button>
        </section>
    );
}
