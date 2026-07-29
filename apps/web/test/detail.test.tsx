import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
    CandidateDetailDTO,
    InterviewQuestionDTO,
    InterviewSummaryDTO,
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
                "Adaptabilidad: la puntuación debe ser un entero entre 1 y 5.",
            ),
        ).toBeInTheDocument();
        // Ninguna llamada PATCH salió hacia la API.
        expect(
            calls.filter((call) => call.init.method === "PATCH"),
        ).toHaveLength(0);
    });

    it("envía el PATCH y muestra el finalScore recalculado por el backend", async () => {
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
                    finalScore: 3.85,
                    confidence: null,
                    evidenceSummary: null,
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

        expect(await screen.findByText("3.85")).toBeInTheDocument();
        await waitFor(() => {
            const patch = calls.find((call) => call.init.method === "PATCH");
            expect(patch).toBeDefined();
            expect(JSON.parse(String(patch!.init.body))).toEqual({
                adaptability: 4,
            });
        });
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
