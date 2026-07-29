import { AppError } from "../shared/errors";
import {
    ProcessRow,
    ProcessPurgeCounts,
    ProcessUpdate,
} from "./process.repository";

/**
 * DTOs y validación de entrada del dominio Process.
 *
 * Los usecases reciben el body crudo (`unknown`) y lo validan aquí: nada de
 * confiar en el tipado del cliente. Los mensajes de error nunca reflejan el
 * valor recibido (podría contener datos sensibles).
 */

/** Longitud máxima del título del rol. */
export const MAX_ROLE_TITLE_LENGTH = 200;
/** Longitud máxima del contexto del rol. */
export const MAX_ROLE_CONTEXT_LENGTH = 10_000;

export interface ProcessResponseDTO {
    id: string;
    roleTitle: string;
    roleContext: string | null;
    status: "active" | "closed";
    createdAt: string;
    closedAt: string | null;
}

/** Respuesta de POST /process/close y DELETE /process. */
export interface ProcessPurgeResponseDTO extends ProcessPurgeCounts {
    deleted: true;
}

export function toProcessResponse(row: ProcessRow): ProcessResponseDTO {
    return {
        id: row.id,
        roleTitle: row.role_title,
        roleContext: row.role_context,
        status: row.status,
        createdAt: row.created_at,
        closedAt: row.closed_at,
    };
}

function asRecord(body: unknown): Record<string, unknown> {
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
        throw new AppError(
            "INVALID_INPUT",
            "El cuerpo de la petición no es válido.",
        );
    }
    return body as Record<string, unknown>;
}

/** Valida y normaliza `roleTitle`: string no vacío (tras trim) y acotado. */
function parseRoleTitle(value: unknown): string {
    if (typeof value !== "string") {
        throw new AppError(
            "INVALID_INPUT",
            "roleTitle es obligatorio y debe ser texto.",
        );
    }
    const trimmed = value.trim();
    if (trimmed.length === 0) {
        throw new AppError("INVALID_INPUT", "roleTitle no puede estar vacío.");
    }
    if (trimmed.length > MAX_ROLE_TITLE_LENGTH) {
        throw new AppError("INVALID_INPUT", "roleTitle es demasiado largo.");
    }
    return trimmed;
}

/** Valida `roleContext`: opcional; string acotado o null. */
function parseRoleContext(value: unknown): string | null {
    if (value === undefined || value === null) {
        return null;
    }
    if (typeof value !== "string") {
        throw new AppError("INVALID_INPUT", "roleContext debe ser texto.");
    }
    const trimmed = value.trim();
    if (trimmed.length > MAX_ROLE_CONTEXT_LENGTH) {
        throw new AppError("INVALID_INPUT", "roleContext es demasiado largo.");
    }
    return trimmed.length === 0 ? null : trimmed;
}

/** Entrada de POST /process. */
export function parseCreateProcessInput(body: unknown): {
    roleTitle: string;
    roleContext: string | null;
} {
    const record = asRecord(body);
    return {
        roleTitle: parseRoleTitle(record.roleTitle),
        roleContext: parseRoleContext(record.roleContext),
    };
}

/** Entrada de PATCH /process: al menos un campo editable presente. */
export function parseUpdateProcessInput(body: unknown): ProcessUpdate {
    const record = asRecord(body);
    const update: ProcessUpdate = {};
    if (record.roleTitle !== undefined) {
        update.roleTitle = parseRoleTitle(record.roleTitle);
    }
    if ("roleContext" in record) {
        update.roleContext = parseRoleContext(record.roleContext);
    }
    if (update.roleTitle === undefined && update.roleContext === undefined) {
        throw new AppError(
            "INVALID_INPUT",
            "Debes indicar al menos un campo a editar (roleTitle o roleContext).",
        );
    }
    return update;
}

/**
 * Borrados definitivos (close/delete): exigen `confirmDelete === true`
 * LITERAL en el body. Cualquier otro valor ("true", 1, ausencia…) se
 * rechaza (BLUEPRINT §17: el borrado definitivo pide confirmación).
 */
export function assertConfirmDelete(body: unknown): void {
    const record =
        typeof body === "object" && body !== null && !Array.isArray(body)
            ? (body as Record<string, unknown>)
            : {};
    if (record.confirmDelete !== true) {
        throw new AppError(
            "INVALID_INPUT",
            "Esta operación borra datos definitivamente: requiere confirmDelete: true.",
        );
    }
}
