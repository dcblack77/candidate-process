import { describe, expect, it } from "vitest";
import { CurrentUser, LOCAL_ADMIN } from "../src/security/current-user";
import {
    canAnalyzeCandidate,
    canCloseProcess,
    canCreateCandidate,
    canCreateProcess,
    canDeleteData,
    canEditScores,
    canExportResults,
    canGenerateQuestions,
    canUploadCV,
    canViewRanking,
    PermissionCheck,
    requirePermission,
} from "../src/security/permissions";
import { AppError } from "../src/shared/errors";

// Las 10 funciones de permisos de BLUEPRINT §09.
const ALL_PERMISSIONS: Array<[string, PermissionCheck]> = [
    ["canCreateProcess", canCreateProcess],
    ["canCreateCandidate", canCreateCandidate],
    ["canUploadCV", canUploadCV],
    ["canAnalyzeCandidate", canAnalyzeCandidate],
    ["canGenerateQuestions", canGenerateQuestions],
    ["canEditScores", canEditScores],
    ["canViewRanking", canViewRanking],
    ["canExportResults", canExportResults],
    ["canCloseProcess", canCloseProcess],
    ["canDeleteData", canDeleteData],
];

describe("permissions (BLUEPRINT §09)", () => {
    it("todas devuelven true para el rol admin", () => {
        for (const [name, check] of ALL_PERMISSIONS) {
            expect(check(LOCAL_ADMIN), name).toBe(true);
        }
    });

    it("todas devuelven false para un rol desconocido", () => {
        const viewer: CurrentUser = { id: "someone", role: "viewer" };
        for (const [name, check] of ALL_PERMISSIONS) {
            expect(check(viewer), name).toBe(false);
        }
    });

    it("requirePermission no lanza cuando el permiso se cumple", () => {
        expect(() =>
            requirePermission(canCreateProcess, LOCAL_ADMIN),
        ).not.toThrow();
    });

    it("requirePermission lanza AppError FORBIDDEN (403) cuando falla", () => {
        const intruder: CurrentUser = { id: "x", role: "guest" };
        try {
            requirePermission(canDeleteData, intruder);
            expect.unreachable("debería haber lanzado");
        } catch (error) {
            expect(error).toBeInstanceOf(AppError);
            const appError = error as AppError;
            expect(appError.code).toBe("FORBIDDEN");
            expect(appError.httpStatus).toBe(403);
        }
    });
});
