import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
    CandidateDetailDTO,
    CandidateScoreDTO,
    InterviewQuestionDTO,
    InterviewSummaryDTO,
    ProposalDTO,
} from "../src/api/types";
import { CandidateDetailPage } from "../src/pages/CandidateDetailPage";
import { installFetchMock, jsonResponse } from "./helpers";

/** Agregados de entrevista sin ninguna respuesta puntuada. */
const EMPTY_INTERVIEW: InterviewSummaryDTO = {
    byCriterion: {
        adaptability: null,
        fundamentals: null,
        depth: null,
        production: null,
        stack: null,
    },
    overall: null,
    answeredCount: 0,
    totalCount: 0,
};

const CANDIDATE: CandidateDetailDTO = {
    id: "c1",
    processId: "p1",
    name: "Ada Lovelace",
    analysisStatus: "analyzed",
    createdAt: "2026-07-20T09:00:00.000Z",
    updatedAt: "2026-07-21T09:00:00.000Z",
    cvSummary: {
        professional_summary: "Ingeniera con 8 años de experiencia backend.",
        evidence: {
            adaptability: [],
            fundamentals: [],
            depth: [],
            production: [],
            stack: [],
        },
        technology_transitions: ["Java → TypeScript (2022)"],
        doubts_for_interview: ["¿Responsabilidad real en producción?"],
        risks: ["Poca exposición reciente a AWS"],
    },
    cvEvidence: {
        adaptability: [
            {
                text: "Migró un monolito Java a TypeScript en 2022",
                type: "explicit",
            },
            {
                text: "Probablemente conoce serverless por su último puesto",
                type: "inferred",
            },
        ],
        fundamentals: [],
        depth: [],
        production: [],
        stack: [],
    },
    score: null,
    questions: [],
    interview: EMPTY_INTERVIEW,
    proposals: [],
};

/** Análisis antiguo, anterior al contraste CV/entrevista: sin veredictos. */
const EMPTY_VERDICTS: CandidateScoreDTO["verdicts"] = {
    adaptability: null,
    fundamentals: null,
    depth: null,
    production: null,
    stack: null,
};

/** Score con la rúbrica completa y sin entrevista puntuada (provisional). */
const SCORE: CandidateScoreDTO = {
    candidateId: "c1",
    scores: {
        adaptability: 5,
        fundamentals: 4,
        depth: 4,
        production: 4,
        stack: 3,
    },
    cvScore: 4.2,
    finalScore: 4.2,
    interviewScore: null,
    overallScore: 4.2,
    provisional: true,
    confidence: 0.8,
    evidenceSummary: null,
    verdicts: EMPTY_VERDICTS,
    manualNotes: null,
    updatedAt: "2026-07-29T10:00:00.000Z",
};

/** Candidato ya entrevistado y re-analizado: un veredicto de cada tipo. */
const CANDIDATE_ASSESSED: CandidateDetailDTO = {
    ...CANDIDATE,
    score: {
        ...SCORE,
        interviewScore: 7.4,
        overallScore: 3.85,
        provisional: false,
        verdicts: {
            adaptability: "confirmed",
            fundamentals: "not_demonstrated",
            depth: "contradicted",
            production: "not_assessed",
            // null: criterio que el análisis no llegó a marcar.
            stack: null,
        },
    },
    proposals: [],
    interview: {
        byCriterion: {
            adaptability: { average: 8, answered: 2 },
            fundamentals: { average: 6, answered: 1 },
            depth: { average: 4, answered: 1 },
            production: null,
            stack: null,
        },
        overall: 7.4,
        answeredCount: 4,
        totalCount: 6,
    },
};

const QUESTION: InterviewQuestionDTO = {
    id: "q1",
    criterion: "adaptability",
    dimension: "Aprendizaje continuo",
    question: "¿Cómo abordaste la migración de Java a TypeScript?",
    validates: "Capacidad de aprender un stack nuevo",
    idealAnswer: null,
    positiveSignals: [],
    warningSignals: [],
    scoringGuidance: null,
    createdAt: "2026-07-22T09:00:00.000Z",
    answerScore: null,
    answerNotes: null,
    answeredAt: null,
};

/** Candidato con una pregunta sin responder (caso de uso en la entrevista). */
const CANDIDATE_WITH_QUESTION: CandidateDetailDTO = {
    ...CANDIDATE,
    questions: [QUESTION],
    interview: { ...EMPTY_INTERVIEW, totalCount: 1 },
};

/** Agregados que devolvería el backend tras puntuar la pregunta con un 8. */
const INTERVIEW_AFTER_8: InterviewSummaryDTO = {
    byCriterion: {
        adaptability: { average: 8, answered: 1 },
        fundamentals: null,
        depth: null,
        production: null,
        stack: null,
    },
    overall: 8,
    answeredCount: 1,
    totalCount: 1,
};

function renderPage() {
    return render(
        <MemoryRouter initialEntries={["/candidates/c1"]}>
            <Routes>
                <Route
                    path="/candidates/:id"
                    element={<CandidateDetailPage />}
                />
            </Routes>
        </MemoryRouter>,
    );
}

describe("CandidateDetailPage", () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("renderiza evidencias explicit y inferred de forma visualmente distinta", async () => {
        installFetchMock({
            "GET /api/candidates/c1": () => jsonResponse(CANDIDATE),
        });
        renderPage();

        const explicitItem = (
            await screen.findByText(
                "Migró un monolito Java a TypeScript en 2022",
            )
        ).closest("li");
        const inferredItem = screen
            .getByText("Probablemente conoce serverless por su último puesto")
            .closest("li");

        expect(explicitItem).toHaveClass("evidence-explicit");
        expect(explicitItem).not.toHaveClass("evidence-inferred");
        expect(inferredItem).toHaveClass("evidence-inferred");
        // La inferida lleva etiqueta textual además del estilo atenuado.
        expect(explicitItem?.textContent).toContain("Explícita");
        expect(inferredItem?.textContent).toContain("Inferida");
    });

    it("valida 1-5 en el formulario de score antes de enviar", async () => {
        const { calls } = installFetchMock({
            "GET /api/candidates/c1": () => jsonResponse(CANDIDATE),
        });
        renderPage();
        const user = userEvent.setup();

        const input = await screen.findByLabelText("Adaptabilidad (1-5)");
        await user.type(input, "7");
        await user.click(
            screen.getByRole("button", { name: "Guardar puntuaciones" }),
        );

        expect(
            await screen.findByText(
                "Adaptabilidad: la puntuación debe estar entre 1 y 5 en pasos de 0,5.",
            ),
        ).toBeInTheDocument();
        // Ninguna llamada PATCH salió hacia la API.
        expect(
            calls.filter((call) => call.init.method === "PATCH"),
        ).toHaveLength(0);
    });

    it("permite enviar puntuaciones con incrementos de medio punto", async () => {
        const { calls } = installFetchMock({
            "GET /api/candidates/c1": () => jsonResponse(CANDIDATE),
            "PATCH /api/candidates/c1/score": () =>
                jsonResponse({
                    ...SCORE,
                    scores: { ...SCORE.scores, production: 2.5 },
                    cvScore: 3.98,
                    finalScore: 3.98,
                    overallScore: 3.98,
                }),
        });
        renderPage();
        const user = userEvent.setup();

        const input = await screen.findByLabelText("Producción (1-5)");
        await user.type(input, "2.5");
        await user.click(
            screen.getByRole("button", { name: "Guardar puntuaciones" }),
        );

        await waitFor(() => {
            const patch = calls.find((call) => call.init.method === "PATCH");
            expect(patch).toBeDefined();
            expect(JSON.parse(String(patch!.init.body))).toEqual({
                production: 2.5,
            });
        });
    });

    // El PATCH devuelve los TRES scores ya calculados por el backend: la UI
    // solo los pinta (nunca recalcula el combinado 30/70).
    it("envía el PATCH y muestra los tres scores recalculados por el backend", async () => {
        const { calls } = installFetchMock({
            "GET /api/candidates/c1": () => jsonResponse(CANDIDATE),
            "PATCH /api/candidates/c1/score": () =>
                jsonResponse({
                    candidateId: "c1",
                    scores: {
                        adaptability: 4,
                        fundamentals: null,
                        depth: null,
                        production: null,
                        stack: null,
                    },
                    // CV 3.85 + entrevista 8.0 → 3.85*0.3 + 4.0*0.7 = 3.96.
                    cvScore: 3.85,
                    finalScore: 3.85,
                    interviewScore: 8,
                    overallScore: 3.96,
                    provisional: false,
                    confidence: null,
                    evidenceSummary: null,
                    verdicts: EMPTY_VERDICTS,
                    manualNotes: null,
                    updatedAt: "2026-07-29T10:00:00.000Z",
                }),
        });
        renderPage();
        const user = userEvent.setup();

        const input = await screen.findByLabelText("Adaptabilidad (1-5)");
        await user.type(input, "4");
        await user.click(
            screen.getByRole("button", { name: "Guardar puntuaciones" }),
        );

        const overview = within(
            await screen.findByLabelText("Resumen de puntuaciones"),
        );
        expect(overview.getByText("3.85")).toBeInTheDocument(); // CV
        expect(overview.getByText("8.0")).toBeInTheDocument(); // entrevista
        expect(overview.getByText("3.96")).toBeInTheDocument(); // combinado
        expect(overview.queryByText(/Provisional/)).not.toBeInTheDocument();

        await waitFor(() => {
            const patch = calls.find((call) => call.init.method === "PATCH");
            expect(patch).toBeDefined();
            expect(JSON.parse(String(patch!.init.body))).toEqual({
                adaptability: 4,
            });
        });
    });
});

// ── Los dos niveles de score y el contraste CV/entrevista (§06/§13) ────────

describe("CandidateDetailPage · score combinado y veredictos", () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("muestra CV, entrevista y score final, con el badge de provisional", async () => {
        installFetchMock({
            "GET /api/candidates/c1": () =>
                jsonResponse({
                    ...CANDIDATE,
                    score: {
                        ...SCORE,
                        interviewScore: null,
                        overallScore: 4.2,
                        provisional: true,
                    },
                }),
        });
        renderPage();

        const overview = within(
            await screen.findByLabelText("Resumen de puntuaciones"),
        );
        expect(overview.getByText("CV · lo que promete")).toBeInTheDocument();
        expect(
            overview.getByText("Entrevista · lo que demostró"),
        ).toBeInTheDocument();
        expect(
            overview.getByText("Score final · ordena la comparativa"),
        ).toBeInTheDocument();
        // Sin entrevista el combinado es todavía el score de CV: mismo número.
        expect(overview.getAllByText("4.20")).toHaveLength(2);
        expect(overview.getByText("—")).toBeInTheDocument(); // sin entrevista
        expect(
            overview.getByText(/Provisional · pendiente de entrevista/),
        ).toHaveClass("badge-provisional");
    });

    it("renderiza cada veredicto con su etiqueta y su estilo", async () => {
        installFetchMock({
            "GET /api/candidates/c1": () => jsonResponse(CANDIDATE_ASSESSED),
        });
        renderPage();

        expect(
            await screen.findByText("✓ Confirmado en entrevista"),
        ).toHaveClass("verdict-confirmed");
        expect(screen.getByText("⚠ No demostrado")).toHaveClass(
            "verdict-not-demonstrated",
        );
        expect(screen.getByText("✗ Contradicho")).toHaveClass(
            "verdict-contradicted",
        );
        // not_assessed y null se muestran igual de discretos.
        const notAssessed = screen.getAllByText("Sin evaluar en entrevista");
        expect(notAssessed).toHaveLength(2);
        expect(notAssessed[0]).toHaveClass("verdict-not-assessed");
    });

    it("avisa de re-analizar si hay entrevista puntuada y ningún veredicto", async () => {
        installFetchMock({
            "GET /api/candidates/c1": () =>
                jsonResponse({
                    ...CANDIDATE,
                    score: SCORE,
                    interview: INTERVIEW_AFTER_8,
                }),
        });
        renderPage();

        expect(
            await screen.findByText(/Vuelve a analizarlo/),
        ).toBeInTheDocument();
    });

    it("no avisa de re-analizar cuando el análisis ya contrastó la entrevista", async () => {
        installFetchMock({
            "GET /api/candidates/c1": () => jsonResponse(CANDIDATE_ASSESSED),
        });
        renderPage();

        // Se espera a que la página cargue antes de comprobar la ausencia.
        expect(
            await screen.findByText("✓ Confirmado en entrevista"),
        ).toBeInTheDocument();
        expect(screen.queryByText(/Vuelve a analizarlo/)).not.toBeInTheDocument();
    });
});

// ── Entrevista: nota 1-10 y notas de la respuesta (§15) ────────────────────

const ANSWER_ROUTE = "PATCH /api/candidates/c1/questions/q1/answer";

/** Abre el bloque colapsable de la pregunta y devuelve su contenedor. */
async function openQuestion(user: ReturnType<typeof userEvent.setup>) {
    const summary = await screen.findByText(
        "¿Cómo abordaste la migración de Java a TypeScript?",
    );
    await user.click(summary);
    const block = summary.closest("details");
    expect(block).not.toBeNull();
    return within(block!);
}

function answerBody(calls: { url: string; init: RequestInit }[]): unknown {
    const patch = calls.find((call) =>
        call.url.endsWith("/questions/q1/answer"),
    );
    expect(patch).toBeDefined();
    expect(patch!.init.method).toBe("PATCH");
    return JSON.parse(String(patch!.init.body));
}

describe("CandidateDetailPage · entrevista", () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("no pinta «Qué valida» aunque la pregunta antigua traiga el campo", async () => {
        installFetchMock({
            "GET /api/candidates/c1": () =>
                jsonResponse(CANDIDATE_WITH_QUESTION),
        });
        renderPage();
        const user = userEvent.setup();

        const question = await openQuestion(user);
        // El bloque sigue mostrando dimensión y criterio...
        expect(question.getByText("Dimensión")).toBeInTheDocument();
        expect(question.getByText("Criterio")).toBeInTheDocument();
        // ...pero «Qué valida» se retiró por redundante (2026-08-07), incluso
        // en las preguntas generadas antes, que aún guardan el texto.
        expect(question.queryByText("Qué valida")).not.toBeInTheDocument();
        expect(
            question.queryByText("Capacidad de aprender un stack nuevo"),
        ).not.toBeInTheDocument();
    });

    it("pulsar una nota envía { score } y refresca el panel de agregados", async () => {
        const { calls } = installFetchMock({
            "GET /api/candidates/c1": () =>
                jsonResponse(CANDIDATE_WITH_QUESTION),
            [ANSWER_ROUTE]: () =>
                jsonResponse({
                    candidateId: "c1",
                    question: {
                        ...QUESTION,
                        answerScore: 8,
                        answeredAt: "2026-07-29T10:00:00.000Z",
                    },
                    interview: INTERVIEW_AFTER_8,
                }),
        });
        renderPage();
        const user = userEvent.setup();

        // Antes de puntuar el panel muestra "—" y 0 respuestas.
        expect(
            await screen.findByText("0/1 preguntas puntuadas"),
        ).toBeInTheDocument();

        const question = await openQuestion(user);
        await user.click(question.getByRole("button", { name: "8" }));

        // Panel actualizado con el `interview` devuelto (sin recargar).
        expect(await screen.findByText("8.0")).toBeInTheDocument();
        expect(
            screen.getByText("1/1 preguntas puntuadas"),
        ).toBeInTheDocument();
        expect(screen.getByText("8.0/10")).toBeInTheDocument();
        // Estado visual de respondida en la cabecera de la pregunta.
        expect(question.getByText(/Respondida · 8\/10/)).toBeInTheDocument();

        expect(answerBody(calls)).toEqual({ score: 8 });
    });

    it("borrar la nota envía { score: null }", async () => {
        const { calls } = installFetchMock({
            "GET /api/candidates/c1": () =>
                jsonResponse({
                    ...CANDIDATE_WITH_QUESTION,
                    questions: [
                        {
                            ...QUESTION,
                            answerScore: 8,
                            answeredAt: "2026-07-29T10:00:00.000Z",
                        },
                    ],
                    interview: INTERVIEW_AFTER_8,
                }),
            [ANSWER_ROUTE]: () =>
                jsonResponse({
                    candidateId: "c1",
                    question: QUESTION,
                    interview: { ...EMPTY_INTERVIEW, totalCount: 1 },
                }),
        });
        renderPage();
        const user = userEvent.setup();

        const question = await openQuestion(user);
        await user.click(question.getByRole("button", { name: "Borrar nota" }));

        await waitFor(() => expect(answerBody(calls)).toEqual({ score: null }));
        // El panel vuelve a "sin respuestas puntuadas".
        expect(
            await screen.findByText("0/1 preguntas puntuadas"),
        ).toBeInTheDocument();
    });

    it("el textarea guarda las notas de la respuesta con { notes }", async () => {
        const { calls } = installFetchMock({
            "GET /api/candidates/c1": () =>
                jsonResponse(CANDIDATE_WITH_QUESTION),
            [ANSWER_ROUTE]: () =>
                jsonResponse({
                    candidateId: "c1",
                    question: {
                        ...QUESTION,
                        answerNotes: "Respondió con un ejemplo concreto.",
                        answeredAt: "2026-07-29T10:00:00.000Z",
                    },
                    interview: { ...EMPTY_INTERVIEW, totalCount: 1 },
                }),
        });
        renderPage();
        const user = userEvent.setup();

        const question = await openQuestion(user);
        await user.type(
            question.getByLabelText("Notas de la respuesta"),
            "Respondió con un ejemplo concreto.",
        );
        await user.click(
            question.getByRole("button", {
                name: "Guardar notas de la respuesta",
            }),
        );

        await waitFor(() =>
            expect(answerBody(calls)).toEqual({
                notes: "Respondió con un ejemplo concreto.",
            }),
        );
        // Aviso de privacidad visible junto al campo.
        expect(
            question.getByText(/no se incluye en el export por defecto/),
        ).toBeInTheDocument();
    });

    it("traduce el error 400 del backend al pulsar una nota", async () => {
        installFetchMock({
            "GET /api/candidates/c1": () =>
                jsonResponse(CANDIDATE_WITH_QUESTION),
            [ANSWER_ROUTE]: () =>
                jsonResponse(
                    {
                        error: {
                            code: "INVALID_INPUT",
                            message: "score debe ser un entero entre 1 y 10.",
                        },
                    },
                    400,
                ),
        });
        renderPage();
        const user = userEvent.setup();

        const question = await openQuestion(user);
        await user.click(question.getByRole("button", { name: "3" }));

        expect(
            await question.findByText(
                "Los datos enviados no son válidos. Revisa el formulario.",
            ),
        ).toBeInTheDocument();
    });
});

/**
 * Propuestas del análisis de audio (§24). Lo que se fija aquí es que nada se
 * aplica solo y que aplicar pasa por el PATCH de la respuesta DE SIEMPRE.
 */
describe("CandidateDetailPage · propuestas del audio", () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    const PROPOSAL: ProposalDTO = {
        id: "pr1",
        questionId: "q1",
        runId: "run1",
        coverage: "abordado_demostrado",
        proposedScore: 8,
        proposedNotes: "Explica la partición y la valida con métricas.",
        evidence: [
            {
                quote: "Partimos por bounded context separando pagos de catálogo",
                startSec: 751,
                endSec: 765,
            },
        ],
        confidence: 0.9,
        status: "proposed",
        createdAt: "2026-08-07T10:00:00.000Z",
        resolvedAt: null,
    };

    const CON_PROPUESTA: CandidateDetailDTO = {
        ...CANDIDATE_WITH_QUESTION,
        proposals: [PROPOSAL],
    };

    it("anuncia la propuesta en la cabecera y muestra la cita con su minuto", async () => {
        installFetchMock({
            "GET /api/candidates/c1": () => jsonResponse(CON_PROPUESTA),
        });
        renderPage();
        const user = userEvent.setup();

        expect(
            await screen.findByText(/Propuesta: Abordado y demostrado · 8\/10/),
        ).toBeInTheDocument();

        const question = await openQuestion(user);
        expect(question.getByText("[12:31]")).toBeInTheDocument();
        expect(
            question.getByText(/Partimos por bounded context/),
        ).toBeInTheDocument();
        // Deja claro de quién es la decisión.
        expect(
            question.getByText(/Revísala antes de aplicarla/),
        ).toBeInTheDocument();
    });

    it("«Usar esta propuesta» escribe la nota por el PATCH de siempre y luego la marca", async () => {
        const { calls } = installFetchMock({
            "GET /api/candidates/c1": () => jsonResponse(CON_PROPUESTA),
            [ANSWER_ROUTE]: () =>
                jsonResponse({
                    candidateId: "c1",
                    question: { ...QUESTION, answerScore: 8 },
                    interview: INTERVIEW_AFTER_8,
                }),
            "PATCH /api/candidates/c1/interview/proposals/pr1": () =>
                jsonResponse({
                    proposal: { ...PROPOSAL, status: "applied" },
                }),
        });
        renderPage();
        const user = userEvent.setup();

        const question = await openQuestion(user);
        await user.click(
            question.getByRole("button", { name: "Usar esta propuesta" }),
        );

        // Se espera a que salgan las DOS llamadas: primero la respuesta real,
        // después el marcado de la propuesta.
        await waitFor(() => {
            expect(
                calls.filter((call) => call.init.method === "PATCH"),
            ).toHaveLength(2);
        });
        expect(
            calls
                .filter((call) => call.init.method === "PATCH")
                .map((call) => call.url),
        ).toEqual([
            "/api/candidates/c1/questions/q1/answer",
            "/api/candidates/c1/interview/proposals/pr1",
        ]);

        const answer = calls.find(
            (call) =>
                call.url === "/api/candidates/c1/questions/q1/answer" &&
                call.init.method === "PATCH",
        );
        expect(answer).toBeDefined();
        expect(JSON.parse(String(answer!.init.body))).toEqual({
            score: 8,
            notes: "Explica la partición y la valida con métricas.",
        });

        const resolved = calls.find(
            (call) =>
                call.url === "/api/candidates/c1/interview/proposals/pr1",
        );
        expect(JSON.parse(String(resolved!.init.body))).toEqual({
            status: "applied",
        });
    });

    it("«Descartar» no toca la respuesta del candidato", async () => {
        const { calls } = installFetchMock({
            "GET /api/candidates/c1": () => jsonResponse(CON_PROPUESTA),
            "PATCH /api/candidates/c1/interview/proposals/pr1": () =>
                jsonResponse({
                    proposal: { ...PROPOSAL, status: "dismissed" },
                }),
        });
        renderPage();
        const user = userEvent.setup();

        const question = await openQuestion(user);
        await user.click(question.getByRole("button", { name: "Descartar" }));

        await screen.findByText(/Propuesta:/);
        expect(
            calls.some((call) => call.url.includes("/questions/q1/answer")),
        ).toBe(false);
    });

    it("una propuesta sin nota no ofrece aplicarla", async () => {
        installFetchMock({
            "GET /api/candidates/c1": () =>
                jsonResponse({
                    ...CANDIDATE_WITH_QUESTION,
                    proposals: [
                        {
                            ...PROPOSAL,
                            coverage: "mencionado",
                            proposedScore: null,
                            evidence: [],
                        },
                    ],
                }),
        });
        renderPage();
        const user = userEvent.setup();

        const question = await openQuestion(user);
        expect(
            question.queryByRole("button", { name: "Usar esta propuesta" }),
        ).not.toBeInTheDocument();
        expect(
            question.getByText(/Sin citas verificadas/),
        ).toBeInTheDocument();
    });

    it("con poca confianza nace plegada y avisa", async () => {
        installFetchMock({
            "GET /api/candidates/c1": () =>
                jsonResponse({
                    ...CANDIDATE_WITH_QUESTION,
                    proposals: [{ ...PROPOSAL, confidence: 0.3 }],
                }),
        });
        renderPage();
        const user = userEvent.setup();

        const question = await openQuestion(user);
        expect(
            question.getByText(/no está seguro de esta propuesta/),
        ).toBeInTheDocument();
        expect(
            question.queryByRole("button", { name: "Usar esta propuesta" }),
        ).not.toBeInTheDocument();

        await user.click(question.getByRole("button", { name: "Ver propuesta" }));
        expect(
            question.getByRole("button", { name: "Usar esta propuesta" }),
        ).toBeInTheDocument();
    });
});
