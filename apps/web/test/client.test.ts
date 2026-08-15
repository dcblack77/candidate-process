import { afterEach, describe, expect, it, vi } from "vitest";
import { api, ApiError, NETWORK_ERROR_CODE } from "../src/api/client";
import { installFetchMock, jsonResponse } from "./helpers";

describe("api/client", () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("parsea errores {error:{code,message}} y lanza ApiError con code", async () => {
        installFetchMock({
            "GET /api/process": () =>
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

        const failure = api.getProcess();
        await expect(failure).rejects.toBeInstanceOf(ApiError);
        await failure.catch((err: ApiError) => {
            expect(err.code).toBe("NOT_FOUND");
            expect(err.httpStatus).toBe(404);
            expect(err.message).toBe("El recurso solicitado no existe.");
        });
    });

    it("tolera cuerpos de error no parseables sin romper", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => ({
                ok: false,
                status: 500,
                json: async () => {
                    throw new Error("no json");
                },
            })),
        );
        await expect(api.getRanking()).rejects.toMatchObject({
            code: "UNKNOWN",
            httpStatus: 500,
        });
    });

    it("convierte fallos de red en ApiError NETWORK_ERROR", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => {
                throw new TypeError("Failed to fetch");
            }),
        );
        await expect(api.health()).rejects.toMatchObject({
            code: NETWORK_ERROR_CODE,
        });
    });

    it("envía el CV como multipart en el campo 'file' sin Content-Type manual", async () => {
        const { calls } = installFetchMock({
            "POST /api/candidates/c1/cv/extract": () =>
                jsonResponse({
                    candidateId: "c1",
                    analysisStatus: "summarized",
                    extractedChars: 1200,
                    truncated: false,
                    cvSummary: {},
                    fileDeleted: true,
                }),
        });

        const file = new File(["hola"], "cv.pdf", { type: "application/pdf" });
        const result = await api.extractCv("c1", file);

        expect(result.fileDeleted).toBe(true);
        expect(calls).toHaveLength(1);
        const call = calls[0]!;
        expect(call.init.method).toBe("POST");
        // El body debe ser FormData con el archivo bajo "file" y el
        // Content-Type lo pone el navegador (boundary incluido).
        expect(call.init.body).toBeInstanceOf(FormData);
        const form = call.init.body as FormData;
        expect(form.get("file")).toBeInstanceOf(File);
        expect((form.get("file") as File).name).toBe("cv.pdf");
        expect(call.init.headers).toBeUndefined();
    });

    it("envía JSON con Content-Type en las mutaciones", async () => {
        const { calls } = installFetchMock({
            "POST /api/candidates": () =>
                jsonResponse({
                    id: "c2",
                    name: "Ada",
                    analysisStatus: "pending",
                    createdAt: "2026-07-29T10:00:00.000Z",
                }),
        });

        await api.createCandidate("Ada");
        const call = calls[0]!;
        expect(call.init.headers).toEqual({
            "Content-Type": "application/json",
        });
        expect(JSON.parse(String(call.init.body))).toEqual({ name: "Ada" });
    });

    it("updateProcess hace PATCH /process con el body JSON (incluido roleContext null)", async () => {
        const { calls } = installFetchMock({
            "PATCH /api/process": () =>
                jsonResponse({
                    id: "p1",
                    roleTitle: "Rol editado",
                    roleContext: null,
                    status: "active",
                    createdAt: "2026-07-01T09:00:00.000Z",
                    closedAt: null,
                }),
        });

        const result = await api.updateProcess({
            roleTitle: "Rol editado",
            roleContext: null,
        });
        expect(result.roleContext).toBeNull();
        const call = calls[0]!;
        expect(call.init.method).toBe("PATCH");
        expect(call.init.headers).toEqual({
            "Content-Type": "application/json",
        });
        expect(JSON.parse(String(call.init.body))).toEqual({
            roleTitle: "Rol editado",
            roleContext: null,
        });
    });

    it("cablea comparación, riesgos y borrado de preguntas con sus rutas", async () => {
        const { calls } = installFetchMock({
            "POST /api/comparison": () => jsonResponse({}),
            "POST /api/candidates/c1/risks": () => jsonResponse({}),
            "GET /api/candidates/c1/risks": () => jsonResponse({}),
            "DELETE /api/candidates/c1/questions/q1": () =>
                jsonResponse({
                    id: "q1",
                    deleted: true,
                    questionsTotal: 0,
                    questionsLimit: 20,
                }),
        });

        await api.compareCandidates(["c1", "c2"]);
        await api.detectCandidateRisks("c1");
        await api.getCandidateRisks("c1");
        await api.deleteQuestion("c1", "q1");

        expect(
            calls.map((call) => `${call.init.method ?? "GET"} ${call.url}`),
        ).toEqual([
            "POST /api/comparison",
            "POST /api/candidates/c1/risks",
            "GET /api/candidates/c1/risks",
            "DELETE /api/candidates/c1/questions/q1",
        ]);
        expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
            candidateIds: ["c1", "c2"],
        });
    });
});
