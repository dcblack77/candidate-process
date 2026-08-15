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
    activeJobId: null,
};

/** Un job tal y como lo devuelve GET .../analysis/:jobId. */
const JOB = {
    candidateId: "c1",
    jobId: "job-vivo",
    recordingId: "r1",
    status: "running" as const,
    phase: "transcribing" as const,
    progress: { done: 0, total: 3 },
    queuePosition: null,
    startedAt: "2026-08-10T10:00:00.000Z",
    finishedAt: null,
    stats: null,
    error: null,
    proposals: [],
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
                jsonResponse({ ...JOB, jobId: "job-nuevo" }),
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
                            lastStatus: "interrupted",
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

describe("cola y reenganche (2026-08-15)", () => {
    it("si hay un análisis vivo al entrar, se reengancha al progreso sin lanzar nada", async () => {
        installMediaMocks({ secureContext: true });
        const { calls } = installFetchMock({
            "GET /api/health": () => jsonResponse(HEALTH_OK),
            "GET /api/candidates/c1/interview/recordings": () =>
                jsonResponse({
                    recordings: [
                        {
                            ...RECORDING,
                            lastStatus: "running",
                            lastRunId: "job-vivo",
                            activeJobId: "job-vivo",
                        },
                    ],
                }),
            "GET /api/candidates/c1/interview/analysis/job-vivo": () =>
                jsonResponse({
                    ...JOB,
                    phase: "assessing",
                    progress: { done: 2, total: 3 },
                }),
        });
        renderPanel();

        // Progreso real del job, no "interrumpido".
        expect(
            await screen.findByText(/Evaluando cada pregunta · 2\/3/),
        ).toBeInTheDocument();
        expect(screen.getByText("Analizando…")).toBeInTheDocument();
        expect(screen.queryByText("Análisis interrumpido")).toBeNull();
        // Ni un POST: solo se ha mirado.
        expect(calls.some((call) => call.init.method === "POST")).toBe(false);
    });

    it("un análisis en cola dice cuántos hay por delante y se puede cancelar", async () => {
        installMediaMocks({ secureContext: true });
        const { calls } = installFetchMock({
            "GET /api/health": () => jsonResponse(HEALTH_OK),
            "GET /api/candidates/c1/interview/recordings": () =>
                jsonResponse({ recordings: [RECORDING] }),
            "POST /api/candidates/c1/interview/analysis/from/r1": () =>
                jsonResponse({
                    ...JOB,
                    jobId: "job-cola",
                    status: "queued",
                    queuePosition: 2,
                }),
            "DELETE /api/candidates/c1/interview/analysis/job-cola": () =>
                jsonResponse({
                    ...JOB,
                    jobId: "job-cola",
                    status: "cancelled",
                    finishedAt: "2026-08-10T10:01:00.000Z",
                }),
        });
        renderPanel();

        await userEvent.click(
            await screen.findByRole("button", { name: /Reanalizar/i }),
        );
        expect(
            await screen.findByText(/En cola · 1 por delante/),
        ).toBeInTheDocument();

        await userEvent.click(
            screen.getByRole("button", { name: "Cancelar análisis" }),
        );
        expect(await screen.findByText("Análisis cancelado.")).toBeInTheDocument();
        expect(
            calls.some(
                (call) =>
                    call.init.method === "DELETE" &&
                    call.url.endsWith("/analysis/job-cola"),
            ),
        ).toBe(true);
    });

    it("si el job desaparece a mitad de sondeo (reinicio) lo explica y ofrece reanalizar", async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        try {
            installMediaMocks({ secureContext: true });
            let recordingsCalls = 0;
            installFetchMock({
                "GET /api/health": () => jsonResponse(HEALTH_OK),
                "GET /api/candidates/c1/interview/recordings": () => {
                    recordingsCalls += 1;
                    return jsonResponse({
                        recordings: [
                            recordingsCalls > 1
                                ? { ...RECORDING, lastStatus: "interrupted" }
                                : RECORDING,
                        ],
                    });
                },
                "POST /api/candidates/c1/interview/analysis/from/r1": () =>
                    jsonResponse({ ...JOB, jobId: "job-muerto" }),
                "GET /api/candidates/c1/interview/analysis/job-muerto": () =>
                    jsonResponse(
                        {
                            error: {
                                code: "NOT_FOUND",
                                message: "El recurso solicitado no existe.",
                            },
                        },
                        404,
                    ),
            });
            renderPanel();

            await userEvent.click(
                await screen.findByRole("button", { name: /Reanalizar/i }),
            );
            expect(
                await screen.findByText(/Transcribiendo el audio/),
            ).toBeInTheDocument();

            await vi.advanceTimersByTimeAsync(2_500);
            expect(
                await screen.findByText(/el servidor se reinició/i),
            ).toBeInTheDocument();
            expect(
                await screen.findByText("Análisis interrumpido"),
            ).toBeInTheDocument();
        } finally {
            vi.useRealTimers();
        }
    });
});
