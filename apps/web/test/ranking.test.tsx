import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RankingResponseDTO } from "../src/api/types";
import { RankingPage } from "../src/pages/RankingPage";
import { installFetchMock, jsonResponse } from "./helpers";

const RANKING: RankingResponseDTO = {
    weights: {
        adaptability: 0.3,
        fundamentals: 0.25,
        depth: 0.2,
        production: 0.15,
        stack: 0.1,
    },
    entries: [
        {
            position: 1,
            candidateId: "c1",
            name: "Ada Lovelace",
            finalScore: 4.35,
            scores: {
                adaptability: 5,
                fundamentals: 4,
                depth: 4,
                production: 4,
                stack: 4,
            },
            confidence: 0.8,
            evidenceSummary: {},
            pendingDoubts: ["¿Lideró la migración o participó?"],
            keyQuestions: ["Cuéntame una transición tecnológica concreta."],
            interviewScore: 8.4,
            interviewByCriterion: {
                adaptability: { average: 9, answered: 2 },
                fundamentals: { average: 7.5, answered: 2 },
                depth: null,
                production: null,
                stack: null,
            },
            tieBreakApplied: null,
            needsManualReview: false,
        },
        {
            position: 2,
            candidateId: "c2",
            name: "Grace Hopper",
            finalScore: 3.9,
            scores: {
                adaptability: 4,
                fundamentals: 4,
                depth: 4,
                production: 3,
                stack: 4,
            },
            confidence: 0.6,
            evidenceSummary: {},
            pendingDoubts: [],
            keyQuestions: [],
            interviewScore: null,
            interviewByCriterion: {
                adaptability: null,
                fundamentals: null,
                depth: null,
                production: null,
                stack: null,
            },
            tieBreakApplied: "adaptability",
            needsManualReview: true,
        },
    ],
    unscored: [
        { candidateId: "c3", name: "Alan Turing", analysisStatus: "pending" },
    ],
};

describe("RankingPage", () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("renderiza el orden, los pesos de cabecera y los badges", async () => {
        installFetchMock({
            "GET /api/ranking": () => jsonResponse(RANKING),
        });
        render(
            <MemoryRouter>
                <RankingPage />
            </MemoryRouter>,
        );

        // Pesos visibles en cabecera (de la respuesta, no hardcodeados aquí).
        const adaptabilityHeader = await screen.findByRole("columnheader", {
            name: /Adaptabilidad/,
        });
        expect(adaptabilityHeader.textContent).toContain("30%");
        expect(
            screen.getByRole("columnheader", { name: /Stack/ }).textContent,
        ).toContain("10%");

        // Orden: Ada (1º) antes que Grace (2º).
        const rows = screen.getAllByRole("row");
        const adaIndex = rows.findIndex((row) =>
            row.textContent?.includes("Ada Lovelace"),
        );
        const graceIndex = rows.findIndex((row) =>
            row.textContent?.includes("Grace Hopper"),
        );
        expect(adaIndex).toBeGreaterThan(0);
        expect(graceIndex).toBeGreaterThan(adaIndex);

        // Scores finales y badge de revisión manual.
        expect(screen.getByText("4.35")).toBeInTheDocument();
        expect(screen.getByText("3.90")).toBeInTheDocument();
        const reviewBadge = screen.getByText("Revisión manual");
        expect(reviewBadge).toHaveClass("badge-warning");
        const graceRow = rows[graceIndex]!;
        expect(
            within(graceRow).getByText("Desempate: adaptabilidad"),
        ).toBeInTheDocument();

        // Dudas y preguntas clave expandibles + sección de sin puntuar.
        expect(
            screen.getByText("¿Lideró la migración o participó?"),
        ).toBeInTheDocument();
        expect(screen.getByText("Alan Turing")).toBeInTheDocument();
    });

    it("muestra la columna Entrevista en escala /10 y '—' cuando no hay notas", async () => {
        installFetchMock({
            "GET /api/ranking": () => jsonResponse(RANKING),
        });
        render(
            <MemoryRouter>
                <RankingPage />
            </MemoryRouter>,
        );

        // La cabecera deja claro que la escala NO es la rúbrica 1-5.
        const header = await screen.findByRole("columnheader", {
            name: /Entrevista/,
        });
        expect(header.textContent).toContain("1-10");

        const rows = screen.getAllByRole("row");
        const adaRow = rows.find((row) =>
            row.textContent?.includes("Ada Lovelace"),
        )!;
        const graceRow = rows.find((row) =>
            row.textContent?.includes("Grace Hopper"),
        )!;
        expect(within(adaRow).getByText("8.4/10")).toBeInTheDocument();
        expect(within(graceRow).getByText("—")).toBeInTheDocument();

        // Desglose por criterio al expandir la fila.
        expect(
            screen.getByText(/Adaptabilidad: 9\.0\/10 \(2 respuestas\)/),
        ).toBeInTheDocument();
        expect(
            screen.getByText(/Fundamentos: 7\.5\/10 \(2 respuestas\)/),
        ).toBeInTheDocument();
    });

    it("el badge dice 'desempatado por entrevista' cuando tieBreakApplied es interview", async () => {
        installFetchMock({
            "GET /api/ranking": () =>
                jsonResponse({
                    ...RANKING,
                    entries: [
                        RANKING.entries[0]!,
                        {
                            ...RANKING.entries[1]!,
                            tieBreakApplied: "interview",
                        },
                    ],
                }),
        });
        render(
            <MemoryRouter>
                <RankingPage />
            </MemoryRouter>,
        );

        const badge = await screen.findByText(/desempatado por entrevista/i);
        expect(badge).toHaveClass("badge-neutral");
    });
});
