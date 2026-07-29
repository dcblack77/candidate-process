import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProcessProvider } from "../src/context/ProcessContext";
import { ClosePage } from "../src/pages/ClosePage";
import { installFetchMock, jsonResponse } from "./helpers";

const PROCESS = {
    id: "p1",
    roleTitle: "Backend Engineer",
    roleContext: null,
    status: "active" as const,
    createdAt: "2026-07-01T09:00:00.000Z",
    closedAt: null,
};

function renderPage() {
    return render(
        <MemoryRouter>
            <ProcessProvider>
                <ClosePage />
            </ProcessProvider>
        </MemoryRouter>,
    );
}

describe("ClosePage", () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("deshabilita el botón de cierre hasta cumplir la doble confirmación", async () => {
        installFetchMock({
            "GET /api/process": () => jsonResponse(PROCESS),
        });
        renderPage();
        const user = userEvent.setup();

        const closeButton = await screen.findByRole("button", {
            name: "Cerrar proceso y borrar datos",
        });
        expect(closeButton).toBeDisabled();

        // Solo el checkbox: sigue deshabilitado.
        await user.click(
            screen.getByLabelText("Entiendo que se borrarán todos los datos"),
        );
        expect(closeButton).toBeDisabled();

        // Nombre del rol incorrecto: sigue deshabilitado.
        const titleInput = screen.getByLabelText(
            /Escribe el nombre del rol para confirmar/,
        );
        await user.type(titleInput, "Otro rol");
        expect(closeButton).toBeDisabled();

        // Nombre exacto + checkbox: se habilita.
        await user.clear(titleInput);
        await user.type(titleInput, "Backend Engineer");
        expect(closeButton).toBeEnabled();

        // Si se desmarca el checkbox vuelve a deshabilitarse.
        await user.click(
            screen.getByLabelText("Entiendo que se borrarán todos los datos"),
        );
        expect(closeButton).toBeDisabled();
    });

    it("llama a POST /process/close con confirmDelete y muestra el estado final", async () => {
        const { calls } = installFetchMock({
            "GET /api/process": () => jsonResponse(PROCESS),
            "POST /api/process/close": () =>
                jsonResponse({
                    deleted: true,
                    candidatesDeleted: 3,
                    scoresDeleted: 2,
                    questionsDeleted: 12,
                }),
        });
        renderPage();
        const user = userEvent.setup();

        await screen.findByRole("button", {
            name: "Cerrar proceso y borrar datos",
        });
        await user.click(
            screen.getByLabelText("Entiendo que se borrarán todos los datos"),
        );
        await user.type(
            screen.getByLabelText(/Escribe el nombre del rol para confirmar/),
            "Backend Engineer",
        );
        await user.click(
            screen.getByRole("button", {
                name: "Cerrar proceso y borrar datos",
            }),
        );

        expect(
            await screen.findByText(
                "Proceso cerrado: los datos se han borrado definitivamente.",
            ),
        ).toBeInTheDocument();
        expect(screen.getByText("Candidatos borrados: 3")).toBeInTheDocument();

        const close = calls.find(
            (call) =>
                call.url === "/api/process/close" &&
                call.init.method === "POST",
        );
        expect(close).toBeDefined();
        expect(JSON.parse(String(close!.init.body))).toEqual({
            confirmDelete: true,
        });
    });
});
