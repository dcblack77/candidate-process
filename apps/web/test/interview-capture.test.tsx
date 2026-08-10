import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InterviewAnalysisPanel } from "../src/interview/InterviewAnalysisPanel";
import { installFetchMock, installMediaMocks, jsonResponse } from "./helpers";

/**
 * Captura del audio de la entrevista (§24, Fase B).
 *
 * Lo que se fija aquí: que la pantalla NUNCA se rompe cuando el navegador no
 * puede grabar (el caso de la LAN), que el error de la casilla sin marcar
 * tiene instrucción propia, y que al desmontar no queda ni un micrófono
 * abierto.
 */

const HEALTH_OK = { status: "ok", db: true, llm: true, stt: true };

function renderPanel() {
    return render(
        <InterviewAnalysisPanel
            candidateId="c1"
            onFinished={() => Promise.resolve()}
        />,
    );
}

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe("InterviewAnalysisPanel · degradación", () => {
    it("sin contexto seguro no ofrece grabar, da la dirección cifrada y deja subir el archivo", async () => {
        installMediaMocks({ secureContext: false });
        installFetchMock({ "GET /api/health": () => jsonResponse(HEALTH_OK) });
        renderPanel();

        expect(
            await screen.findByText(/solo da acceso al micrófono por HTTPS/i),
        ).toBeInTheDocument();
        // La salida es un clic, no una explicación: la misma dirección cifrada.
        expect(
            screen.getByRole("link", {
                name: `https://${window.location.host}`,
            }),
        ).toBeInTheDocument();
        expect(
            screen.queryByRole("button", { name: "Grabar entrevista" }),
        ).not.toBeInTheDocument();
        // El camino alternativo sigue disponible: desde la LAN se usa así.
        expect(
            screen.getByLabelText(/sube una grabación/i),
        ).toBeInTheDocument();
    });

    it("sin captura de pestaña (Firefox) avisa pero permite subir", async () => {
        installMediaMocks({ getDisplayMedia: false });
        installFetchMock({ "GET /api/health": () => jsonResponse(HEALTH_OK) });
        renderPanel();

        // Con micrófono disponible sí deja grabar, pero el aviso de subida
        // sigue estando.
        expect(
            await screen.findByRole("button", { name: "Grabar entrevista" }),
        ).toBeInTheDocument();
        expect(screen.getByLabelText(/sube una grabación/i)).toBeEnabled();
    });

    it("con la transcripción caída bloquea todo y dice cómo levantarla", async () => {
        installMediaMocks();
        installFetchMock({
            "GET /api/health": () =>
                jsonResponse({ ...HEALTH_OK, stt: false }),
        });
        renderPanel();

        expect(
            await screen.findByText(/no responde/i),
        ).toBeInTheDocument();
        expect(screen.getByText(/--profile voice up -d/)).toBeInTheDocument();
        expect(
            screen.getByRole("button", { name: "Grabar entrevista" }),
        ).toBeDisabled();
        expect(screen.getByLabelText(/sube una grabación/i)).toBeDisabled();
    });
});

describe("InterviewAnalysisPanel · grabación", () => {
    it("graba, muestra el cronómetro y los medidores por pista", async () => {
        installMediaMocks();
        installFetchMock({ "GET /api/health": () => jsonResponse(HEALTH_OK) });
        renderPanel();
        const user = userEvent.setup();

        await user.click(
            await screen.findByRole("button", { name: "Grabar entrevista" }),
        );

        expect(
            await screen.findByRole("button", { name: "Detener y analizar" }),
        ).toBeInTheDocument();
        expect(screen.getByText("00:00")).toBeInTheDocument();
        // Un medidor por pista: sirve para ver en el minuto 1 que algo no suena.
        expect(
            screen.getByRole("meter", { name: "Nivel de Micrófono" }),
        ).toBeInTheDocument();
        expect(
            screen.getByRole("meter", { name: "Nivel de Pestaña" }),
        ).toBeInTheDocument();
    });

    it("compartir la pestaña sin audio da la instrucción exacta y no graba", async () => {
        installMediaMocks({ tabAudioTracks: 0 });
        installFetchMock({ "GET /api/health": () => jsonResponse(HEALTH_OK) });
        renderPanel();
        const user = userEvent.setup();

        await user.click(
            await screen.findByRole("button", { name: "Grabar entrevista" }),
        );

        expect(
            await screen.findByText(/Compartir también el audio de la pestaña/),
        ).toBeInTheDocument();
        // Se comprueba por el botón, no por el texto "Grabando": el aviso de
        // subir un archivo suelto también contiene esa palabra.
        expect(
            screen.queryByRole("button", { name: "Detener y analizar" }),
        ).not.toBeInTheDocument();
        // Se puede reintentar.
        expect(
            screen.getByRole("button", { name: "Grabar entrevista" }),
        ).toBeEnabled();
    });

    it("si se deniega el permiso lo dice sin tecnicismos", async () => {
        installMediaMocks({ micError: "NotAllowedError" });
        installFetchMock({ "GET /api/health": () => jsonResponse(HEALTH_OK) });
        renderPanel();
        const user = userEvent.setup();

        await user.click(
            await screen.findByRole("button", { name: "Grabar entrevista" }),
        );

        expect(
            await screen.findByText(/Denegaste el permiso/),
        ).toBeInTheDocument();
    });

    it("«Detener y analizar» sube las DOS pistas por separado", async () => {
        installMediaMocks();
        const { calls } = installFetchMock({
            "GET /api/health": () => jsonResponse(HEALTH_OK),
            "POST /api/candidates/c1/interview/analysis": () =>
                jsonResponse(
                    {
                        candidateId: "c1",
                        jobId: "j1",
                        status: "running",
                        phase: "transcribing",
                        progress: { done: 0, total: 1 },
                        startedAt: "2026-08-07T10:00:00.000Z",
                    },
                    202,
                ),
            "GET /api/candidates/c1/interview/analysis/j1": () =>
                jsonResponse({
                    candidateId: "c1",
                    jobId: "j1",
                    status: "done",
                    phase: "done",
                    progress: { done: 1, total: 1 },
                    startedAt: "2026-08-07T10:00:00.000Z",
                    finishedAt: "2026-08-07T10:05:00.000Z",
                    stats: { questionsAssessed: 3 },
                    error: null,
                    proposals: [],
                }),
        });
        renderPanel();
        const user = userEvent.setup();

        await user.click(
            await screen.findByRole("button", { name: "Grabar entrevista" }),
        );
        await user.click(
            await screen.findByRole("button", { name: "Detener y analizar" }),
        );

        await waitFor(() => {
            expect(
                calls.some((call) =>
                    call.url.includes("/interview/analysis"),
                ),
            ).toBe(true);
        });

        const post = calls.find(
            (call) =>
                call.url === "/api/candidates/c1/interview/analysis" &&
                call.init.method === "POST",
        );
        expect(post).toBeDefined();
        const form = post!.init.body as FormData;
        // Dos pistas separadas: es lo que permite saber quién dijo cada cosa.
        expect(form.get("mic")).not.toBeNull();
        expect(form.get("tab")).not.toBeNull();
        expect(JSON.parse(String(form.get("meta")))).toEqual({
            candidateSource: "tab",
        });
    });

    it("al desmontar no deja ninguna pista abierta ni el AudioContext vivo", async () => {
        const media = installMediaMocks();
        installFetchMock({ "GET /api/health": () => jsonResponse(HEALTH_OK) });
        const { unmount } = renderPanel();
        const user = userEvent.setup();

        await user.click(
            await screen.findByRole("button", { name: "Grabar entrevista" }),
        );
        await screen.findByRole("button", { name: "Detener y analizar" });

        unmount();

        await waitFor(() => {
            // Micrófono + audio de pestaña (el vídeo ya se paró al obtenerlo).
            expect(media.stoppedTracks).toBeGreaterThanOrEqual(2);
            expect(media.audioContextClosed).toBe(true);
        });
        expect(media.recorders.every((r) => r.stopped)).toBe(true);
    });

    it("descarta el vídeo de la pestaña: solo interesa el sonido", async () => {
        const media = installMediaMocks();
        installFetchMock({ "GET /api/health": () => jsonResponse(HEALTH_OK) });
        renderPanel();
        const user = userEvent.setup();

        await user.click(
            await screen.findByRole("button", { name: "Grabar entrevista" }),
        );
        await screen.findByRole("button", { name: "Detener y analizar" });

        // La pista de vídeo se para nada más obtener el stream, mucho antes
        // de detener la grabación.
        expect(media.stoppedTracks).toBeGreaterThanOrEqual(1);
    });
});
