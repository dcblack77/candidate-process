import { AppError } from "../shared/errors";
import { CurrentUser } from "./current-user";

/**
 * Capa de permisos (BLUEPRINT §09).
 *
 * Regla: los permisos se validan SIEMPRE en backend, nunca solo ocultando
 * botones en la interfaz. En MVP todas las funciones devuelven `true` para
 * el rol `admin` y `false` en cualquier otro caso.
 */

export type PermissionCheck = (user: CurrentUser) => boolean;

function isAdmin(user: CurrentUser): boolean {
    return user.role === "admin";
}

export const canCreateProcess: PermissionCheck = (user) => isAdmin(user);
export const canCreateCandidate: PermissionCheck = (user) => isAdmin(user);
export const canUploadCV: PermissionCheck = (user) => isAdmin(user);
export const canAnalyzeCandidate: PermissionCheck = (user) => isAdmin(user);
export const canGenerateQuestions: PermissionCheck = (user) => isAdmin(user);
export const canEditScores: PermissionCheck = (user) => isAdmin(user);
export const canViewRanking: PermissionCheck = (user) => isAdmin(user);
export const canExportResults: PermissionCheck = (user) => isAdmin(user);
/** Subir audio de entrevista y lanzar su análisis (§24). */
export const canTranscribeInterview: PermissionCheck = (user) => isAdmin(user);
export const canCloseProcess: PermissionCheck = (user) => isAdmin(user);
export const canDeleteData: PermissionCheck = (user) => isAdmin(user);

/**
 * Exige un permiso concreto: si la comprobación falla, lanza
 * AppError FORBIDDEN (403) con mensaje genérico.
 *
 * Uso: `requirePermission(canCreateProcess, req.currentUser);`
 */
export function requirePermission(
    check: PermissionCheck,
    user: CurrentUser,
): void {
    if (!check(user)) {
        throw new AppError("FORBIDDEN");
    }
}
