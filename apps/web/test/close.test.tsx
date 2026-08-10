import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProcessListItemDTO, ProcessResponseDTO } from "../src/api/types";
import { ProcessProvider } from "../src/context/ProcessContext";
import { ClosePage } from "../src/pages/ClosePage";
import { installFetchMock, jsonResponse } from "./helpers";

const PROCESS: ProcessResponseDTO = {
    id: "p1",
    roleTitle: "Backend Engineer",
    roleContext: null,
    status: "active",
    createdAt: "2026-07-01T09:00:00.000Z",
    closedAt: null,
    isCurrent: true,
};

const LIST_ITEM: ProcessListItemDTO = {
    id: "p1",
    roleTitle: "Backend Engineer",
    status: "active",
    createdAt: "2026-07-01T09:00:00.000Z",
    closedAt: null,
    isCurrent: true,
    candidateCount: 3,
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

describe("ClosePage — archivar", () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("archivar no pide confirmación y no manda confirmDelete", async () => {
        let current: ProcessResponseDTO = PROCESS;
        const { calls } = installFetchMock({
            "GET /api/process": () => jsonResponse(current),
            "GET /api/process/list": () => jsonResponse([LIST_ITEM]),
            "POST /api/process/close": () => {
                current = {
                    ...PROCESS,
                    status: "closed",
                    closedAt: "2026-08-07T10:00:00.000Z",
                };
                return jsonResponse(current);
            },
        });
        renderPage();
        const user = userEvent.setup();

        const archiveButton = await screen.findByRole("button", {
            name: "Archivar proceso",
        });
        expect(archiveButton).toBeEnabled();
        await user.click(archiveButton);

        expect(
            await screen.findByText(/ya está archivado/i),
        ).toBeInTheDocument();

        const close = calls.find(
            (call) =>
                call.url === "/api/process/close" &&
                call.init.method === "POST",
        );
        expect(close).toBeDefined();
        // Archivar no destruye nada: no lleva cuerpo de confirmación.
        expect(close!.init.body).toBeUndefined();
    });

    it("deja claro que no hay que archivar para abrir otro proceso", async () => {
        installFetchMock({
            "GET /api/process": () => jsonResponse(PROCESS),
            "GET /api/process/list": () => jsonResponse([LIST_ITEM]),
        });
        renderPage();

        expect(
            await screen.findByText(/No hace falta archivar para abrir otro/i),
        ).toBeInTheDocument();
    });

    it("si el proceso ya llega archivado no ofrece archivarlo otra vez", async () => {
        installFetchMock({
            "GET /api/process": () =>
                jsonResponse({
                    ...PROCESS,
                    status: "closed",
                    closedAt: "2026-08-01T10:00:00.000Z",
                }),
            "GET /api/process/list": () =>
                jsonResponse([{ ...LIST_ITEM, status: "closed" }]),
        });
        renderPage();

        expect(
            await screen.findByText(/ya está archivado/i),
        ).toBeInTheDocument();
        expect(
            screen.queryByRole("button", { name: "Archivar proceso" }),
        ).not.toBeInTheDocument();
    });
});

describe("ClosePage — borrado definitivo", () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("deshabilita el botón de borrado hasta cumplir la doble confirmación", async () => {
        installFetchMock({
            "GET /api/process": () => jsonResponse(PROCESS),
            "GET /api/process/list": () => jsonResponse([LIST_ITEM]),
        });
        renderPage();
        const user = userEvent.setup();

        const deleteButton = await screen.findByRole("button", {
            name: "Borrar proceso y sus datos",
        });
        expect(deleteButton).toBeDisabled();

        // Solo el checkbox: sigue deshabilitado.
        await user.click(
            screen.getByLabelText("Entiendo que se borrarán todos los datos"),
        );
        expect(deleteButton).toBeDisabled();

        // Nombre del rol incorrecto: sigue deshabilitado.
        const titleInput = screen.getByLabelText(
            /Escribe el nombre del rol para confirmar/,
        );
        await user.type(titleInput, "Otro rol");
        expect(deleteButton).toBeDisabled();

        // Nombre exacto + checkbox: se habilita.
        await user.clear(titleInput);
        await user.type(titleInput, "Backend Engineer");
        expect(deleteButton).toBeEnabled();

        // Si se desmarca el checkbox vuelve a deshabilitarse.
        await user.click(
            screen.getByLabelText("Entiendo que se borrarán todos los datos"),
        );
        expect(deleteButton).toBeDisabled();
    });

    it("llama a DELETE /process/:id con confirmDelete y muestra los conteos", async () => {
        const { calls } = installFetchMock({
            "GET /api/process": () => jsonResponse(PROCESS),
            "GET /api/process/list": () => jsonResponse([LIST_ITEM]),
            "DELETE /api/process/p1": () =>
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
            name: "Borrar proceso y sus datos",
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
                name: "Borrar proceso y sus datos",
            }),
        );

        expect(
            await screen.findByText(
                "Proceso borrado: los datos se han eliminado definitivamente.",
            ),
        ).toBeInTheDocument();
        expect(screen.getByText("Candidatos borrados: 3")).toBeInTheDocument();

        const remove = calls.find(
            (call) =>
                call.url === "/api/process/p1" &&
                call.init.method === "DELETE",
        );
        expect(remove).toBeDefined();
        expect(JSON.parse(String(remove!.init.body))).toEqual({
            confirmDelete: true,
        });
    });
});
