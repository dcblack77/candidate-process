import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
    DEFAULT_EXPORT_INCLUDE,
    ExportInclude,
    ExportStructuredResponseDTO,
} from "../src/api/types";
import { PrintExportProvider } from "../src/context/PrintExportContext";
import { ExportPage } from "../src/pages/ExportPage";
import {
    ExportPrintPage,
    PrintExportDocument,
} from "../src/pages/ExportPrintPage";
import { installFetchMock, jsonResponse } from "./helpers";

const EXPORT_RESPONSE = {
    format: "markdown" as const,
    filename: "informe-backend-engineer.md",
    content: "# Informe del proceso\n\n## Ranking\n1. Ada Lovelace",
    exportsUsedThisSession: 1,
    exportsLimit: 10,
};

/** Centinelas: texto que SOLO puede salir con include.privateNotes. */
const SENTINEL_NOTE = "NOTA-PRIVADA-CENTINELA-77";
const SENTINEL_ANSWER_NOTE = "RESPUESTA-PRIVADA-CENTINELA-88";

/**
 * Fixture del export estructurado. Por defecto llega ya filtrado por el
 * backend (sin notas privadas), igual que en producción.
 */
function structuredFixture(
    overrides: Partial<ExportStructuredResponseDTO> = {},
): ExportStructuredResponseDTO {
    const include: ExportInclude = {
        ...DEFAULT_EXPORT_INCLUDE,
        ...(overrides.include ?? {}),
    };
    const privateNotes = include.privateNotes;
    return {
        format: "structured",
        filename: "export-backend-senior-2026-07-29.pdf",
        generatedAt: "2026-07-29T10:30:00.000Z",
        roleTitle: "Backend Sénior Serverless",
        roleContext: "Equipo pequeño, mucho AWS.",
        weights: {
            adaptability: 0.3,
            fundamentals: 0.25,
            depth: 0.2,
            production: 0.15,
            stack: 0.1,
        },
        scoreWeights: { cv: 0.3, interview: 0.7 },
        entries: [
            {
                position: 1,
                name: "Ana Ejemplo",
                cvScore: 3.75,
                overallScore: 3.93,
                provisional: false,
                scores: {
                    adaptability: 5,
                    fundamentals: 4,
                    depth: 3,
                    production: 3,
                    stack: 2,
                },
                verdicts: {
                    adaptability: "confirmed",
                    fundamentals: null,
                    depth: "not_demonstrated",
                    production: "contradicted",
                    stack: null,
                },
                confidence: 0.8,
                needsManualReview: false,
                summary: "Resumen profesional breve de Ana.",
                strengths: ["FORTALEZA: migró Java a Node."],
                risks: ["RIESGO: poca operación en producción."],
                doubts: ["DUDA: validar profundidad."],
                questions: [
                    {
                        question: "PREGUNTA: cuéntame una transición.",
                        answerScore: 8,
                        answerNotes: privateNotes ? SENTINEL_ANSWER_NOTE : null,
                    },
                ],
                interview: {
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
                },
                manualNotes: privateNotes ? SENTINEL_NOTE : null,
            },
            {
                position: 2,
                name: "Beto Ejemplo",
                cvScore: 3,
                overallScore: 3,
                provisional: true,
                scores: {
                    adaptability: 3,
                    fundamentals: 3,
                    depth: 3,
                    production: 3,
                    stack: 3,
                },
                verdicts: {
                    adaptability: null,
                    fundamentals: null,
                    depth: null,
                    production: null,
                    stack: null,
                },
                confidence: null,
                needsManualReview: false,
                summary: null,
                strengths: [],
                risks: [],
                doubts: [],
                questions: [],
                interview: {
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
                },
                manualNotes: null,
            },
        ],
        unscored: ["Pendiente Uno"],
        exportsUsedThisSession: 1,
        exportsLimit: 10,
        ...overrides,
        include,
    };
}

/** Pantalla Exportar con el contexto de impresión y su ruta destino. */
function renderPage(initialEntry = "/export") {
    return render(
        <MemoryRouter initialEntries={[initialEntry]}>
            <PrintExportProvider>
                <Routes>
                    <Route path="/export" element={<ExportPage />} />
                    <Route
                        path="/export/print"
                        element={<ExportPrintPage />}
                    />
                </Routes>
            </PrintExportProvider>
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
            format: string;
            include: Record<string, boolean>;
        };
        expect(body.format).toBe("markdown");
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

    it("«Ver como PDF» pide format:'structured' y navega a la vista de impresión", async () => {
        const { calls } = installFetchMock({
            "POST /api/export": () => jsonResponse(structuredFixture()),
        });
        renderPage();
        const user = userEvent.setup();

        await user.click(screen.getByRole("button", { name: "Ver como PDF" }));

        const post = calls.find((call) => call.init.method === "POST");
        const body = JSON.parse(String(post!.init.body)) as {
            format: string;
            include: Record<string, boolean>;
        };
        expect(body.format).toBe("structured");
        expect(body.include.privateNotes).toBe(false);

        // Ya en /export/print, con el documento maquetado.
        expect(
            await screen.findByRole("button", {
                name: "Imprimir / Guardar como PDF",
            }),
        ).toBeInTheDocument();
        expect(
            screen.getByRole("heading", { name: "Backend Sénior Serverless" }),
        ).toBeInTheDocument();
        // Una sola llamada a la API: el límite de 10 no se consume dos veces.
        expect(
            calls.filter((call) => call.init.method === "POST"),
        ).toHaveLength(1);
    });
});

describe("ExportPrintPage", () => {
    afterEach(() => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it("sin datos preparados muestra el aviso y el enlace a Exportar", () => {
        renderPage("/export/print");

        expect(
            screen.getByText(/No hay ningún export preparado para imprimir/),
        ).toBeInTheDocument();
        expect(
            screen.getByRole("link", { name: "Exportar" }),
        ).toBeInTheDocument();
    });

    it("el botón de imprimir llama a window.print()", async () => {
        const print = vi.fn();
        vi.stubGlobal("print", print);
        installFetchMock({
            "POST /api/export": () => jsonResponse(structuredFixture()),
        });
        renderPage();
        const user = userEvent.setup();

        await user.click(screen.getByRole("button", { name: "Ver como PDF" }));
        await user.click(
            await screen.findByRole("button", {
                name: "Imprimir / Guardar como PDF",
            }),
        );

        expect(print).toHaveBeenCalledTimes(1);
    });
});

describe("PrintExportDocument", () => {
    it("renderiza portada, tabla de ranking y una ficha por candidato", () => {
        const { container } = render(
            <PrintExportDocument data={structuredFixture()} />,
        );

        // Portada.
        expect(
            screen.getByRole("heading", { name: "Backend Sénior Serverless" }),
        ).toBeInTheDocument();
        expect(
            screen.getByText("Equipo pequeño, mucho AWS."),
        ).toBeInTheDocument();
        expect(screen.getByText(/no redistribuir/)).toBeInTheDocument();
        // Nº de candidatos evaluados.
        expect(screen.getByText("Candidatos evaluados").nextSibling)
            .toHaveTextContent("2");

        // Tabla de ranking con la fórmula tomada de scoreWeights.
        expect(
            screen.getByText(/Score final = CV×30% \+ Entrevista×70%/),
        ).toBeInTheDocument();
        expect(screen.getByText(/Adaptabilidad 30%/)).toBeInTheDocument();
        expect(screen.getByText(/\* Score provisional/)).toBeInTheDocument();

        // Una ficha por candidato, cada una en su sección de página nueva.
        const cards = container.querySelectorAll(".print-candidate");
        expect(cards).toHaveLength(2);
        expect(
            screen.getByRole("heading", { name: "1. Ana Ejemplo" }),
        ).toBeInTheDocument();
        expect(
            screen.getByRole("heading", { name: "2. Beto Ejemplo" }),
        ).toBeInTheDocument();

        // Contenido de la ficha: criterios, resumen, fortalezas, riesgos,
        // dudas y preguntas con su nota.
        const ana = cards[0] as HTMLElement;
        expect(within(ana).getByText("Adaptabilidad")).toBeInTheDocument();
        expect(
            within(ana).getByText("✓ Confirmado en entrevista"),
        ).toBeInTheDocument();
        expect(
            within(ana).getByText("Resumen profesional breve de Ana."),
        ).toBeInTheDocument();
        expect(
            within(ana).getByText("FORTALEZA: migró Java a Node."),
        ).toBeInTheDocument();
        expect(
            within(ana).getByText("RIESGO: poca operación en producción."),
        ).toBeInTheDocument();
        expect(
            within(ana).getByText("DUDA: validar profundidad."),
        ).toBeInTheDocument();
        expect(
            within(ana).getByText(/nota de la respuesta: 8\/10/),
        ).toBeInTheDocument();

        // Candidatos sin puntuar.
        expect(screen.getByText("Pendiente Uno")).toBeInTheDocument();
    });

    it("el score que se muestra como final es overallScore, no el de CV", () => {
        const { container } = render(
            <PrintExportDocument data={structuredFixture()} />,
        );

        // En la tabla: la celda destacada es el combinado.
        const overall = container.querySelectorAll(".print-overall");
        expect(overall[0]).toHaveTextContent("3.93");
        // El provisional se marca con asterisco.
        expect(overall[1]).toHaveTextContent("3.00*");

        // En la ficha: "Score final 3.93" con el CV aparte.
        const ana = container.querySelector(".print-candidate") as HTMLElement;
        expect(
            within(ana).getByText("Score final 3.93"),
        ).toBeInTheDocument();
        expect(ana.textContent).toContain("CV 3.75");
    });

    it("las notas privadas NO se pintan con el flag desactivado", () => {
        render(<PrintExportDocument data={structuredFixture()} />);

        expect(document.body.textContent).not.toContain(SENTINEL_NOTE);
        expect(document.body.textContent).not.toContain(SENTINEL_ANSWER_NOTE);
        expect(
            screen.queryByText(/Notas privadas del evaluador/),
        ).not.toBeInTheDocument();
        expect(
            screen.queryByText(/Contiene información privada/),
        ).not.toBeInTheDocument();
        // La nota numérica sí sale: es puntuación, no texto sensible.
        expect(
            screen.getByText(/nota de la respuesta: 8\/10/),
        ).toBeInTheDocument();
    });

    it("con include.privateNotes las notas privadas se pintan y la portada avisa", () => {
        render(
            <PrintExportDocument
                data={structuredFixture({
                    include: {
                        ...DEFAULT_EXPORT_INCLUDE,
                        privateNotes: true,
                    },
                })}
            />,
        );

        expect(
            screen.getByText(/Contiene información privada/),
        ).toBeInTheDocument();
        expect(
            screen.getByText(/Notas privadas del evaluador/),
        ).toBeInTheDocument();
        expect(document.body.textContent).toContain(SENTINEL_NOTE);
        expect(document.body.textContent).toContain(SENTINEL_ANSWER_NOTE);
    });

    it("el contenido del modelo se pinta como TEXTO: nunca se interpreta como HTML", () => {
        // Regla de seguridad: el resumen y las evidencias vienen del modelo y
        // del CV. Si se renderizaran como markdown/HTML, una imagen o un
        // enlace podrían exfiltrar datos al imprimir.
        const malicious = '<img src="http://evil.example/x.png"> [f](http://evil.example)';
        const data = structuredFixture();
        data.entries[0]!.summary = malicious;

        const { container } = render(<PrintExportDocument data={data} />);

        expect(container.querySelector("img")).toBeNull();
        expect(container.querySelector("a")).toBeNull();
        expect(screen.getByText(malicious)).toBeInTheDocument();
    });
});
