import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProcessListItemDTO, ProcessResponseDTO } from "../src/api/types";
import { ProcessProvider } from "../src/context/ProcessContext";
import { HomePage } from "../src/pages/HomePage";
import { installFetchMock, jsonResponse } from "./helpers";

const PROCESS: ProcessResponseDTO = {
    id: "p1",
    roleTitle: "Backend Engineer",
    roleContext: "Equipo de plataforma.",
    status: "active",
    createdAt: "2026-07-01T09:00:00.000Z",
    closedAt: null,
    isCurrent: true,
};

/** Entrada de /process/list correspondiente a PROCESS. */
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
                <HomePage />
            </ProcessProvider>
        </MemoryRouter>,
    );
}

describe("HomePage — edición del proceso", () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("el formulario de edición se abre precargado con el proceso en curso", async () => {
        installFetchMock({
            "GET /api/process": () => jsonResponse(PROCESS),
            "GET /api/process/list": () => jsonResponse([LIST_ITEM]),
        });
        renderPage();
        const user = userEvent.setup();

        await screen.findByText("Proceso en curso: Backend Engineer");
        expect(screen.getByText("Equipo de plataforma.")).toBeInTheDocument();

        await user.click(
            screen.getByRole("button", { name: "Editar proceso" }),
        );

        expect(screen.getByLabelText("Título del rol")).toHaveValue(
            "Backend Engineer",
        );
        expect(
            screen.getByLabelText("Contexto del rol (opcional)"),
        ).toHaveValue("Equipo de plataforma.");
    });

    it("guarda con PATCH /process y el resumen refleja el contexto nuevo", async () => {
        // GET devuelve el estado 'persistido' para que el refresh posterior
        // al guardado muestre lo mismo que confirmó el backend.
        let current = PROCESS;
        const { calls } = installFetchMock({
            "GET /api/process": () => jsonResponse(current),
            "GET /api/process/list": () => jsonResponse([LIST_ITEM]),
            "PATCH /api/process": () => {
                current = {
                    ...current,
                    roleContext: "Equipo de pagos, stack AWS.",
                };
                return jsonResponse(current);
            },
        });
        renderPage();
        const user = userEvent.setup();

        await screen.findByText("Proceso en curso: Backend Engineer");
        await user.click(
            screen.getByRole("button", { name: "Editar proceso" }),
        );

        const contextInput = screen.getByLabelText(
            "Contexto del rol (opcional)",
        );
        await user.clear(contextInput);
        await user.type(contextInput, "Equipo de pagos, stack AWS.");
        await user.click(
            screen.getByRole("button", { name: "Guardar cambios" }),
        );

        // Tras guardar se vuelve al resumen con el contexto actualizado.
        expect(
            await screen.findByText("Equipo de pagos, stack AWS."),
        ).toBeInTheDocument();

        const patch = calls.find(
            (call) =>
                call.url === "/api/process" && call.init.method === "PATCH",
        );
        expect(patch).toBeDefined();
        expect(JSON.parse(String(patch!.init.body))).toEqual({
            roleTitle: "Backend Engineer",
            roleContext: "Equipo de pagos, stack AWS.",
        });
    });

    it("vaciar el contexto lo envía como null para borrarlo", async () => {
        let current = PROCESS;
        const { calls } = installFetchMock({
            "GET /api/process": () => jsonResponse(current),
            "GET /api/process/list": () => jsonResponse([LIST_ITEM]),
            "PATCH /api/process": () => {
                current = { ...current, roleContext: null };
                return jsonResponse(current);
            },
        });
        renderPage();
        const user = userEvent.setup();

        await screen.findByText("Proceso en curso: Backend Engineer");
        await user.click(
            screen.getByRole("button", { name: "Editar proceso" }),
        );
        await user.clear(
            screen.getByLabelText("Contexto del rol (opcional)"),
        );
        await user.click(
            screen.getByRole("button", { name: "Guardar cambios" }),
        );

        expect(
            await screen.findByText("Sin contexto del rol."),
        ).toBeInTheDocument();

        const patch = calls.find(
            (call) =>
                call.url === "/api/process" && call.init.method === "PATCH",
        );
        expect(patch).toBeDefined();
        expect(JSON.parse(String(patch!.init.body))).toEqual({
            roleTitle: "Backend Engineer",
            roleContext: null,
        });
    });
});

describe("HomePage — varios procesos a la vez", () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("sin ningún proceso muestra el alta inicial, no el listado", async () => {
        installFetchMock({
            "GET /api/process": () =>
                jsonResponse(
                    { error: { code: "NOT_FOUND", message: "no hay" } },
                    404,
                ),
            "GET /api/process/list": () => jsonResponse([]),
        });
        renderPage();

        expect(
            await screen.findByRole("heading", { name: "Crear proceso" }),
        ).toBeInTheDocument();
        expect(screen.queryByText("Otros procesos")).not.toBeInTheDocument();
    });

    it("«Abrir otro proceso» crea uno nuevo sin cerrar el anterior", async () => {
        let current: ProcessResponseDTO = PROCESS;
        let list: ProcessListItemDTO[] = [LIST_ITEM];
        const { calls } = installFetchMock({
            "GET /api/process": () => jsonResponse(current),
            "GET /api/process/list": () => jsonResponse(list),
            "POST /api/process": () => {
                current = {
                    ...PROCESS,
                    id: "p2",
                    roleTitle: "Data Engineer",
                    roleContext: null,
                };
                list = [
                    { ...LIST_ITEM, isCurrent: false },
                    {
                        ...LIST_ITEM,
                        id: "p2",
                        roleTitle: "Data Engineer",
                        isCurrent: true,
                        candidateCount: 0,
                    },
                ];
                return jsonResponse(current, 201);
            },
        });
        renderPage();
        const user = userEvent.setup();

        await screen.findByText("Proceso en curso: Backend Engineer");
        await user.click(
            screen.getByRole("button", { name: "Abrir otro proceso" }),
        );

        // El formulario avisa de que no se cierra ni se borra nada.
        expect(
            screen.getByText(/no se cierra ni se borra nada/i),
        ).toBeInTheDocument();

        await user.type(
            screen.getByLabelText("Título del rol"),
            "Data Engineer",
        );
        await user.click(screen.getByRole("button", { name: "Abrir proceso" }));

        // El nuevo pasa a ser el proceso en curso y el anterior sigue ahí.
        expect(
            await screen.findByText("Proceso en curso: Data Engineer"),
        ).toBeInTheDocument();
        expect(screen.getByText("Backend Engineer")).toBeInTheDocument();

        const post = calls.find(
            (call) => call.url === "/api/process" && call.init.method === "POST",
        );
        expect(JSON.parse(String(post!.init.body))).toEqual({
            roleTitle: "Data Engineer",
        });
    });

    it("cambiar de proceso llama a /select y recarga el que quede en curso", async () => {
        let current: ProcessResponseDTO = PROCESS;
        let list: ProcessListItemDTO[] = [
            LIST_ITEM,
            {
                ...LIST_ITEM,
                id: "p2",
                roleTitle: "Data Engineer",
                isCurrent: false,
                candidateCount: 1,
            },
        ];
        const { calls } = installFetchMock({
            "GET /api/process": () => jsonResponse(current),
            "GET /api/process/list": () => jsonResponse(list),
            "POST /api/process/p2/select": () => {
                current = {
                    ...PROCESS,
                    id: "p2",
                    roleTitle: "Data Engineer",
                    roleContext: null,
                };
                list = list.map((p) => ({ ...p, isCurrent: p.id === "p2" }));
                return jsonResponse(current);
            },
        });
        renderPage();
        const user = userEvent.setup();

        await screen.findByText("Proceso en curso: Backend Engineer");
        // El otro proceso aparece con su recuento de candidatos.
        expect(screen.getByText(/1 candidato/)).toBeInTheDocument();

        await user.click(screen.getByRole("button", { name: "Data Engineer" }));

        expect(
            await screen.findByText("Proceso en curso: Data Engineer"),
        ).toBeInTheDocument();
        expect(
            calls.some((call) => call.url === "/api/process/p2/select"),
        ).toBe(true);
    });

    it("un proceso archivado se anuncia como solo lectura y ofrece reabrir", async () => {
        let current: ProcessResponseDTO = {
            ...PROCESS,
            status: "closed",
            closedAt: "2026-08-01T10:00:00.000Z",
        };
        const { calls } = installFetchMock({
            "GET /api/process": () => jsonResponse(current),
            "GET /api/process/list": () =>
                jsonResponse([{ ...LIST_ITEM, status: "closed" }]),
            "POST /api/process/p1/reopen": () => {
                current = PROCESS;
                return jsonResponse(current);
            },
        });
        renderPage();
        const user = userEvent.setup();

        await screen.findByText("Proceso archivado: Backend Engineer");
        expect(screen.getByText(/no modificar nada/i)).toBeInTheDocument();
        // Sin edición mientras esté archivado.
        expect(
            screen.queryByRole("button", { name: "Editar proceso" }),
        ).not.toBeInTheDocument();

        await user.click(
            screen.getByRole("button", { name: "Reabrir proceso" }),
        );

        expect(
            await screen.findByText("Proceso en curso: Backend Engineer"),
        ).toBeInTheDocument();
        expect(
            calls.some((call) => call.url === "/api/process/p1/reopen"),
        ).toBe(true);
    });
});
