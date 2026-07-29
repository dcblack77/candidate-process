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
});
