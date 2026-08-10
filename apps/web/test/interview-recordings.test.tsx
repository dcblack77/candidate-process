import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InterviewAnalysisPanel } from "../src/interview/InterviewAnalysisPanel";
import { installFetchMock, installMediaMocks, jsonResponse } from "./helpers";

/**
 * Grabaciones guardadas y reanálisis (§24, 2026-08-10).
 *
 * Lo que se fija aquí: que un análisis caído se puede reintentar sin volver a
 * subir el audio —el fallo que motivó persistirlo— y que el audio guardado
 * siempre es visible y borrable, porque es dato de una persona real.
 */

const HEALTH_OK = { status: "ok", db: true, llm: true, stt: true };

const RECORDING = {
    id: "r1",
    createdAt: "2026-08-10T09:30:00.000Z",
    candidateSource: "tab" as const,
    tracks: [{ label: "tab", speaker: "candidato" as const, bytes: 2_000_000 }],
    bytes: 2_100_000,
    hasTranscript: true,
    durationSec: 1830,
    segments: 240,
    lastRunId: "job-viejo",
    lastStatus: "failed" as const,
    lastErrorCode: "LLM_UNAVAILABLE",
};

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

describe("grabaciones guardadas", () => {
    it("enseña la grabación de un análisis fallido con su tamaño y duración", async () => {
        installMediaMocks({ secureContext: true });
        installFetchMock({
            "GET /api/health": () => jsonResponse(HEALTH_OK),
            "GET /api/candidates/c1/interview/recordings": () =>
                jsonResponse({ recordings: [RECORDING] }),
        });
        renderPanel();

        expect(
            await screen.findByText("El análisis falló"),
        ).toBeInTheDocument();
        // Tamaño y duración a la vista: es la única señal de cuánto audio de
        // una persona real hay guardado.
        expect(screen.getByText(/30:30/)).toBeInTheDocument();
        expect(screen.getByText(/2\.0 MB/)).toBeInTheDocument();
    });

    it("reanalizar no vuelve a subir audio y avisa de que no retranscribe", async () => {
        installMediaMocks({ secureContext: true });
        const { calls } = installFetchMock({
            "GET /api/health": () => jsonResponse(HEALTH_OK),
            "GET /api/candidates/c1/interview/recordings": () =>
                jsonResponse({ recordings: [RECORDING] }),
            "POST /api/candidates/c1/interview/analysis/from/r1": () =>
                jsonResponse({
                    candidateId: "c1",
                    jobId: "job-nuevo",
                    recordingId: "r1",
                    status: "running",
                    phase: "transcribing",
                    progress: { done: 0, total: 3 },
                    startedAt: "2026-08-10T10:00:00.000Z",
                    finishedAt: null,
                    stats: null,
                    error: null,
                    proposals: [],
                }),
        });
        renderPanel();

        const button = await screen.findByRole("button", {
            name: /Reanalizar \(sin transcribir de nuevo\)/i,
        });
        await userEvent.click(button);

        await waitFor(() => {
            expect(
                calls.some(
                    (call) =>
                        call.url ===
                        "/api/candidates/c1/interview/analysis/from/r1",
                ),
            ).toBe(true);
        });
        // Es un POST con JSON, no un multipart: no se resube nada.
        const resume = calls.find(
            (call) =>
                call.url === "/api/candidates/c1/interview/analysis/from/r1",
        );
        expect(resume?.init.method).toBe("POST");
        expect(String(resume?.init.body)).not.toContain("webm");
    });

    it("sin transcripción guardada avisa de que volverá a transcribir", async () => {
        installMediaMocks({ secureContext: true });
        installFetchMock({
            "GET /api/health": () => jsonResponse(HEALTH_OK),
            "GET /api/candidates/c1/interview/recordings": () =>
                jsonResponse({
                    recordings: [
                        {
                            ...RECORDING,
                            hasTranscript: false,
                            durationSec: null,
                            lastStatus: "running",
                        },
                    ],
                }),
        });
        renderPanel();

        expect(
            await screen.findByText("Análisis interrumpido"),
        ).toBeInTheDocument();
        expect(
            screen.getByText(/volverá a transcribir el audio/i),
        ).toBeInTheDocument();
    });

    it("borrar pide confirmación y solo entonces llama a la API", async () => {
        installMediaMocks({ secureContext: true });
        const { calls } = installFetchMock({
            "GET /api/health": () => jsonResponse(HEALTH_OK),
            "GET /api/candidates/c1/interview/recordings": () =>
                jsonResponse({ recordings: [RECORDING] }),
            "DELETE /api/candidates/c1/interview/recordings/r1": () =>
                jsonResponse({ id: "r1", deleted: true }),
        });
        renderPanel();

        const del = await screen.findByRole("button", {
            name: "Borrar grabación",
        });

        // Cancelar no borra: es irreversible y destruye audio de una persona.
        const confirmSpy = vi
            .spyOn(window, "confirm")
            .mockReturnValueOnce(false);
        await userEvent.click(del);
        expect(confirmSpy).toHaveBeenCalled();
        expect(
            calls.some((call) => call.init.method === "DELETE"),
        ).toBe(false);

        confirmSpy.mockReturnValue(true);
        await userEvent.click(del);
        await waitFor(() => {
            expect(
                calls.some((call) => call.init.method === "DELETE"),
            ).toBe(true);
        });
    });

    it("sin grabaciones no enseña la sección", async () => {
        installMediaMocks({ secureContext: true });
        installFetchMock({
            "GET /api/health": () => jsonResponse(HEALTH_OK),
            "GET /api/candidates/c1/interview/recordings": () =>
                jsonResponse({ recordings: [] }),
        });
        renderPanel();

        await screen.findByRole("button", { name: "Grabar entrevista" });
        expect(
            screen.queryByText("Grabaciones guardadas"),
        ).not.toBeInTheDocument();
    });
});
