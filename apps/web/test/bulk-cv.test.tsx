import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../src/api/client";
import { CvBulkImportItemDTO, CvBulkImportResponseDTO } from "../src/api/types";
import { CandidatesPage } from "../src/pages/CandidatesPage";
import { installFetchMock, jsonResponse } from "./helpers";

/**
 * Carga masiva de CVs (§16): selección con vista previa y nombres, envío
 * multipart, polling del job y cancelación. fetch mockeado: nunca se llama
 * a la API real.
 */

function renderPage() {
    return render(
        <MemoryRouter>
            <CandidatesPage />
        </MemoryRouter>,
    );
}

function file(name: string, size = 10, type = "application/pdf"): File {
    return new File(["x".repeat(size)], name, { type });
}

function job(
    overrides: Partial<CvBulkImportResponseDTO> = {},
): CvBulkImportResponseDTO {
    return {
        jobId: "j1",
        processId: "p1",
        status: "running",
        startedAt: "2026-08-15T10:00:00.000Z",
        finishedAt: null,
        errorCode: null,
        cancelRequested: false,
        counts: {
            total: 2,
            rejected: 0,
            queued: 1,
            summarizing: 1,
            summarized: 0,
            failed: 0,
            skipped: 0,
            cancelled: 0,
        },
        items: [
            {
                index: 0,
                candidateId: "c1",
                name: "Ana Perez",
                status: "summarizing",
                errorCode: null,
                extractedChars: 1200,
                truncated: false,
                llmWaits: 0,
            },
            {
                index: 1,
                candidateId: "c2",
                name: "Luis Gómez",
                status: "queued",
                errorCode: null,
                extractedChars: 900,
                truncated: false,
                llmWaits: 0,
            },
        ],
        filesDeleted: true,
        ...overrides,
    };
}

/** Los dos archivos del job de ejemplo, tipados sin `undefined`. */
const [ANA, LUIS] = job().items as [CvBulkImportItemDTO, CvBulkImportItemDTO];

async function pickFiles(files: File[]) {
    const input = screen.getByLabelText(
        "Archivos de CV para la carga masiva",
    ) as HTMLInputElement;
    // El input está oculto: userEvent.upload lo rellena igual. Sin
    // applyAccept:false userEvent filtraría los formatos no admitidos y no
    // se podría probar que la UI los marca.
    await userEvent.upload(input, files, { applyAccept: false });
}

describe("BulkCvUploadPanel", () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("muestra la vista previa con nombre opcional y bloquea formatos no admitidos", async () => {
        installFetchMock({
            "GET /api/candidates": () => jsonResponse([]),
        });
        renderPage();
        await screen.findByText("Carga masiva de CVs");

        await pickFiles([
            file("cv_ana-perez.pdf"),
            file("notas.md", 5, "text/markdown"),
        ]);

        expect(screen.getByText("cv_ana-perez.pdf")).toBeInTheDocument();
        expect(screen.getByText("notas.md")).toBeInTheDocument();
        expect(
            screen.getByText("Formato no admitido (PDF, DOCX o TXT)."),
        ).toBeInTheDocument();
        // Con un archivo problemático no se puede importar.
        const submit = screen.getByRole("button", { name: "Importar 2 CVs" });
        expect(submit).toBeDisabled();

        // Se quita el archivo malo y el botón se habilita.
        await userEvent.click(
            screen.getByRole("button", { name: "Quitar notas.md" }),
        );
        expect(screen.queryByText("notas.md")).not.toBeInTheDocument();
        expect(
            screen.getByRole("button", { name: "Importar 1 CV" }),
        ).toBeEnabled();
    });

    it("un archivo de más de 10 MB queda marcado y bloquea el lote", async () => {
        installFetchMock({
            "GET /api/candidates": () => jsonResponse([]),
        });
        renderPage();
        await screen.findByText("Carga masiva de CVs");

        const big = new File(
            [new Uint8Array(10 * 1024 * 1024 + 1)],
            "gigante.pdf",
            {
                type: "application/pdf",
            },
        );
        await pickFiles([big]);
        expect(screen.getByText("Supera los 10 MB.")).toBeInTheDocument();
        expect(
            screen.getByRole("button", { name: "Importar 1 CV" }),
        ).toBeDisabled();
    });

    it("envía multipart con `files` (+ `names` solo si se escribió alguno), pinta el job y hace polling hasta terminar", async () => {
        let polls = 0;
        const { calls } = installFetchMock({
            "GET /api/candidates": () => jsonResponse([]),
            "POST /api/candidates/cv/bulk": () => jsonResponse(job(), 202),
            "GET /api/candidates/cv/bulk/j1": () => {
                polls += 1;
                return jsonResponse(
                    polls === 1
                        ? job()
                        : job({
                              status: "done",
                              finishedAt: "2026-08-15T10:01:00.000Z",
                              counts: {
                                  total: 2,
                                  rejected: 0,
                                  queued: 0,
                                  summarizing: 0,
                                  summarized: 2,
                                  failed: 0,
                                  skipped: 0,
                                  cancelled: 0,
                              },
                              items: [
                                  { ...ANA, status: "summarized" },
                                  {
                                      ...LUIS,
                                      status: "summarized",
                                      truncated: true,
                                  },
                              ],
                          }),
                );
            },
        });
        renderPage();
        await screen.findByText("Carga masiva de CVs");

        await pickFiles([file("cv_ana-perez.pdf"), file("luis.docx")]);
        await userEvent.type(
            screen.getByLabelText("Nombre del candidato para luis.docx"),
            "Luis Gómez",
        );
        await userEvent.click(
            screen.getByRole("button", { name: "Importar 2 CVs" }),
        );

        // Petición: multipart con los dos archivos y names alineado.
        await waitFor(() => {
            expect(
                calls.some((call) => call.url === "/api/candidates/cv/bulk"),
            ).toBe(true);
        });
        const post = calls.find(
            (call) => call.url === "/api/candidates/cv/bulk",
        )!;
        expect(post.init.method).toBe("POST");
        const form = post.init.body as FormData;
        expect(form.getAll("files")).toHaveLength(2);
        expect((form.getAll("files")[0] as File).name).toBe("cv_ana-perez.pdf");
        expect(JSON.parse(String(form.get("names")))).toEqual([
            null,
            "Luis Gómez",
        ]);

        // El job se pinta con sus estados.
        const jobView = await screen.findByTestId("bulk-job");
        expect(within(jobView).getByText("Resumiendo")).toBeInTheDocument();
        expect(within(jobView).getByText("En cola")).toBeInTheDocument();
        expect(
            within(jobView).getByRole("link", { name: "Ana Perez" }),
        ).toHaveAttribute("href", "/candidates/c1");
        expect(
            within(jobView).getByRole("button", { name: "Cancelar lote" }),
        ).toBeInTheDocument();
        // La selección se vacía tras enviar.
        expect(
            screen.queryByRole("button", { name: "Importar 2 CVs" }),
        ).not.toBeInTheDocument();

        // Polling (2 s) hasta 'done'; la lista se refresca por el camino.
        await waitFor(
            () => {
                expect(
                    screen.getByText("Lote terminado: 2 de 2 con resumen"),
                ).toBeInTheDocument();
            },
            { timeout: 6000 },
        );
        expect(within(jobView).getAllByText("Resumen listo")).toHaveLength(2);
        expect(
            within(jobView).getByText("Texto recortado a 50.000 caracteres."),
        ).toBeInTheDocument();
        expect(
            calls.filter((call) => call.url === "/api/candidates").length,
        ).toBeGreaterThan(1);
        expect(
            screen.getByRole("button", { name: "Cerrar" }),
        ).toBeInTheDocument();
    }, 10000);

    it("sin nombres escritos no viaja el campo names", async () => {
        const { calls } = installFetchMock({
            "GET /api/candidates": () => jsonResponse([]),
            "POST /api/candidates/cv/bulk": () =>
                jsonResponse(job({ status: "done" }), 202),
        });
        renderPage();
        await screen.findByText("Carga masiva de CVs");
        await pickFiles([file("a.pdf")]);
        await userEvent.click(
            screen.getByRole("button", { name: "Importar 1 CV" }),
        );
        await waitFor(() => {
            const post = calls.find(
                (call) => call.url === "/api/candidates/cv/bulk",
            );
            expect(post).toBeDefined();
            expect((post!.init.body as FormData).has("names")).toBe(false);
        });
    });

    it("cancelar llama a DELETE y muestra la cancelación", async () => {
        installFetchMock({
            "GET /api/candidates": () => jsonResponse([]),
            "POST /api/candidates/cv/bulk": () => jsonResponse(job(), 202),
            "DELETE /api/candidates/cv/bulk/j1": () =>
                jsonResponse(
                    job({
                        cancelRequested: true,
                        items: [ANA, { ...LUIS, status: "cancelled" }],
                    }),
                ),
            "GET /api/candidates/cv/bulk/j1": () =>
                jsonResponse(
                    job({
                        status: "cancelled",
                        cancelRequested: true,
                        finishedAt: "2026-08-15T10:01:00.000Z",
                        counts: {
                            total: 2,
                            rejected: 0,
                            queued: 0,
                            summarizing: 0,
                            summarized: 1,
                            failed: 0,
                            skipped: 0,
                            cancelled: 1,
                        },
                        items: [
                            { ...ANA, status: "summarized" },
                            { ...LUIS, status: "cancelled" },
                        ],
                    }),
                ),
        });
        renderPage();
        await screen.findByText("Carga masiva de CVs");
        await pickFiles([file("a.pdf"), file("b.pdf")]);
        await userEvent.click(
            screen.getByRole("button", { name: "Importar 2 CVs" }),
        );
        const cancel = await screen.findByRole("button", {
            name: "Cancelar lote",
        });
        await userEvent.click(cancel);

        expect(await screen.findByText(/cancelando…/)).toBeInTheDocument();
        await waitFor(
            () => {
                expect(
                    screen.getByText(
                        "Lote cancelado: 1 con resumen, 1 sin empezar",
                    ),
                ).toBeInTheDocument();
            },
            { timeout: 6000 },
        );
        expect(screen.getByText("Cancelado")).toBeInTheDocument();
    }, 10000);

    it("los límites del lote muestran el mensaje concreto del backend", async () => {
        installFetchMock({
            "GET /api/candidates": () => jsonResponse([]),
            "POST /api/candidates/cv/bulk": () =>
                jsonResponse(
                    {
                        error: {
                            code: "LIMIT_EXCEEDED",
                            message:
                                "El lote no cabe en el proceso: tiene 99 candidatos, el lote añade 2 y el máximo es 100.",
                        },
                    },
                    422,
                ),
        });
        renderPage();
        await screen.findByText("Carga masiva de CVs");
        await pickFiles([file("a.pdf"), file("b.pdf")]);
        await userEvent.click(
            screen.getByRole("button", { name: "Importar 2 CVs" }),
        );
        expect(
            await screen.findByText(
                "El lote no cabe en el proceso: tiene 99 candidatos, el lote añade 2 y el máximo es 100.",
            ),
        ).toBeInTheDocument();
        // La selección se conserva para corregir y reintentar.
        expect(
            screen.getByRole("button", { name: "Importar 2 CVs" }),
        ).toBeEnabled();
    });

    it("el lote detenido por el modelo explica qué hacer con los pendientes", async () => {
        installFetchMock({
            "GET /api/candidates": () => jsonResponse([]),
            "POST /api/candidates/cv/bulk": () =>
                jsonResponse(
                    job({
                        status: "failed",
                        errorCode: "LLM_UNAVAILABLE",
                        finishedAt: "2026-08-15T10:01:00.000Z",
                        counts: {
                            total: 2,
                            rejected: 0,
                            queued: 0,
                            summarizing: 0,
                            summarized: 0,
                            failed: 1,
                            skipped: 0,
                            cancelled: 1,
                        },
                        items: [
                            {
                                ...ANA,
                                status: "failed",
                                errorCode: "LLM_UNAVAILABLE",
                            },
                            { ...LUIS, status: "cancelled" },
                        ],
                    }),
                    202,
                ),
        });
        renderPage();
        await screen.findByText("Carga masiva de CVs");
        await pickFiles([file("a.pdf"), file("b.pdf")]);
        await userEvent.click(
            screen.getByRole("button", { name: "Importar 2 CVs" }),
        );
        expect(
            await screen.findByText(/El modelo local dejó de responder/),
        ).toBeInTheDocument();
        expect(
            screen.getByText(/Arranca el modelo y sube el CV desde su fila/),
        ).toBeInTheDocument();
    });

    it("api.startBulkCvImport no adjunta names si todos son null", async () => {
        const { calls } = installFetchMock({
            "POST /api/candidates/cv/bulk": () => jsonResponse(job(), 202),
        });
        await api.startBulkCvImport([file("a.pdf")], [null]);
        const form = calls[0]!.init.body as FormData;
        expect(form.has("names")).toBe(false);
        expect(form.getAll("files")).toHaveLength(1);
    });
});
