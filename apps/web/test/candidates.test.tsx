import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CandidateListItemDTO } from "../src/api/types";
import { CandidatesPage } from "../src/pages/CandidatesPage";
import { installFetchMock, jsonResponse } from "./helpers";

const LIST: CandidateListItemDTO[] = [
    {
        id: "c1",
        name: "Ada Lovelace",
        analysisStatus: "analyzed",
        createdAt: "2026-07-20T09:00:00.000Z",
    },
    {
        id: "c2",
        name: "Grace Hopper",
        analysisStatus: "extracting",
        createdAt: "2026-07-21T09:00:00.000Z",
    },
    {
        id: "c3",
        name: "Alan Turing",
        analysisStatus: "failed",
        createdAt: "2026-07-22T09:00:00.000Z",
    },
];

function renderPage() {
    return render(
        <MemoryRouter>
            <CandidatesPage />
        </MemoryRouter>,
    );
}

describe("CandidatesPage", () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("renderiza los estados con su badge y spinner en los transitorios", async () => {
        installFetchMock({
            "GET /api/candidates": () => jsonResponse(LIST),
        });
        renderPage();

        expect(await screen.findByText("Analizado")).toBeInTheDocument();
        expect(screen.getByText("Extrayendo CV")).toBeInTheDocument();
        expect(screen.getByText("Error")).toBeInTheDocument();

        const analyzedBadge = screen.getByText("Analizado").closest(".badge");
        expect(analyzedBadge).toHaveClass("badge-analyzed");
        const extractingBadge = screen
            .getByText("Extrayendo CV")
            .closest(".badge");
        expect(extractingBadge).toHaveClass("badge-extracting");
        // Los estados en curso muestran spinner dentro del badge.
        expect(
            extractingBadge?.querySelector(".spinner"),
        ).toBeInTheDocument();
        const failedBadge = screen.getByText("Error").closest(".badge");
        expect(failedBadge).toHaveClass("badge-failed");

        // El candidato fallido ofrece reintentar.
        expect(screen.getByText("Reintentar")).toBeInTheDocument();
    });

    it("da de alta un candidato llamando a POST /api/candidates", async () => {
        const { calls } = installFetchMock({
            "GET /api/candidates": () => jsonResponse([]),
            "POST /api/candidates": () =>
                jsonResponse({
                    id: "c9",
                    name: "Marie Curie",
                    analysisStatus: "pending",
                    createdAt: "2026-07-29T10:00:00.000Z",
                }),
        });
        renderPage();
        const user = userEvent.setup();

        const input = await screen.findByLabelText("Nuevo candidato");
        await user.type(input, "Marie Curie");
        await user.click(screen.getByRole("button", { name: "Añadir" }));

        await waitFor(() => {
            const post = calls.find(
                (call) => (call.init.method ?? "GET") === "POST",
            );
            expect(post).toBeDefined();
            expect(post!.url).toBe("/api/candidates");
            expect(JSON.parse(String(post!.init.body))).toEqual({
                name: "Marie Curie",
            });
        });
    });
});
