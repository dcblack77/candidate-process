import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CandidateDetailDTO } from "../src/api/types";
import { CandidateDetailPage } from "../src/pages/CandidateDetailPage";
import { installFetchMock, jsonResponse } from "./helpers";

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
