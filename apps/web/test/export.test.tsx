import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ExportPage } from "../src/pages/ExportPage";
import { installFetchMock, jsonResponse } from "./helpers";

const EXPORT_RESPONSE = {
    format: "markdown" as const,
    filename: "informe-backend-engineer.md",
    content: "# Informe del proceso\n\n## Ranking\n1. Ada Lovelace",
    exportsUsedThisSession: 1,
    exportsLimit: 10,
};

function renderPage() {
    return render(
        <MemoryRouter>
            <ExportPage />
        </MemoryRouter>,
    );
}

describe("ExportPage", () => {
    afterEach(() => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it("arranca con los defaults seguros: notas privadas y texto extraído desmarcados", () => {
        renderPage();

        expect(screen.getByLabelText(/Ranking/)).toBeChecked();
        expect(
            screen.getByLabelText(/Puntuaciones por criterio/),
        ).toBeChecked();
        expect(screen.getByLabelText(/Notas privadas/)).not.toBeChecked();
        expect(
            screen.getByLabelText(/Texto extraído del CV/),
        ).not.toBeChecked();
        // Sin secciones sensibles marcadas no hay aviso.
        expect(
            screen.queryByText(/información sensible \(/),
        ).not.toBeInTheDocument();
    });

    it("al marcar notas privadas aparece el aviso de información sensible", async () => {
        renderPage();
        const user = userEvent.setup();

        await user.click(screen.getByLabelText(/Notas privadas/));

        expect(
            screen.getByText(/has marcado secciones con información sensible/),
        ).toBeInTheDocument();
        expect(screen.getByRole("alert").textContent).toContain(
            "Notas privadas",
        );
    });

    it("genera la vista previa y descarga con el filename de la respuesta", async () => {
        const { calls } = installFetchMock({
            "POST /api/export": () => jsonResponse(EXPORT_RESPONSE),
        });
        renderPage();
        const user = userEvent.setup();

        await user.click(
            screen.getByRole("button", { name: "Generar export" }),
        );

        // Vista previa del markdown + contador de exports.
        expect(
            await screen.findByText(/# Informe del proceso/),
        ).toBeInTheDocument();
        expect(
            screen.getByText("Exportaciones usadas: 1/10"),
        ).toBeInTheDocument();

        // El body enviado lleva los defaults seguros.
        const post = calls.find((call) => call.init.method === "POST");
        const body = JSON.parse(String(post!.init.body)) as {
            include: Record<string, boolean>;
        };
        expect(body.include.privateNotes).toBe(false);
        expect(body.include.extractedText).toBe(false);
        expect(body.include.ranking).toBe(true);

        // Descarga: Blob + a[download] con el filename de la respuesta.
        // jsdom no implementa createObjectURL: se definen a mano.
        let downloadName: string | null = null;
        Object.assign(URL, {
            createObjectURL: vi.fn(() => "blob:fake"),
            revokeObjectURL: vi.fn(),
        });
        vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(
            function (this: HTMLAnchorElement) {
                downloadName = this.download;
            },
        );

        await user.click(
            screen.getByRole("button", {
                name: `Descargar ${EXPORT_RESPONSE.filename}`,
            }),
        );
        await waitFor(() =>
            expect(downloadName).toBe(EXPORT_RESPONSE.filename),
        );
    });
});
