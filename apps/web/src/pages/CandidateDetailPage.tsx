import { FormEvent, useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api } from "../api/client";
import { friendlyMessage } from "../api/errors";
import {
    CandidateDetailDTO,
    CandidateScoreDTO,
    CRITERIA,
    Criterion,
    CRITERION_LABELS,
    CvSummary,
    EvidenceItem,
    EvidenceSummary,
    InterviewQuestionDTO,
} from "../api/types";
import { EvidenceList } from "../components/EvidenceList";
import { ErrorAlert, Spinner, StatusBadge } from "../components/ui";

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
                    muestran atenuadas: valídalas en entrevista.
                </p>
                {CRITERIA.map((criterion) => (
                    <div key={criterion}>
                        <h3>{CRITERION_LABELS[criterion]}</h3>
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
                onGenerated={load}
            />
            <NotesSection
                candidateId={id}
                initialNotes={candidate.score?.manualNotes ?? ""}
            />
        </>
    );
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
                    {savedScore?.finalScore != null && (
                        <span>
                            Score final:{" "}
                            <span className="final-score">
                                {savedScore.finalScore.toFixed(2)}
                            </span>
                        </span>
                    )}
                </div>
            </form>
        </section>
    );
}

// ── Preguntas de entrevista ────────────────────────────────────────────────

function QuestionsSection({
    candidateId,
    questions,
    onGenerated,
}: {
    candidateId: string;
    questions: InterviewQuestionDTO[];
    onGenerated: () => Promise<void>;
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
            {questions.length === 0 && (
                <p className="muted">Aún no se han generado preguntas.</p>
            )}
            {questions.map((question) => (
                <QuestionBlock key={question.id} question={question} />
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

/** Bloque completo de §14, colapsable por pregunta. */
function QuestionBlock({ question }: { question: InterviewQuestionDTO }) {
    return (
        <details className="question">
            <summary>{question.question}</summary>
            <div className="question-body">
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
