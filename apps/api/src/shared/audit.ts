import { inject, injectable } from "@expressots/core";
import { Database, DB } from "../db/database";
import { AppError } from "./errors";
import { newId } from "./ids";

/**
 * Auditoría AppEvent (BLUEPRINT §12 y §17).
 *
 * `metadata` admite SOLO valores primitivos cortos: ids, contadores y
 * duraciones. Jamás contenido de CVs, resúmenes, notas ni prompts.
 * El guard de abajo lo fuerza en runtime para evitar fugas accidentales.
 */

export type AuditMetadataValue = string | number | boolean | null;
export type AuditMetadata = Record<string, AuditMetadataValue>;

/** Longitud máxima de un valor string en metadata (un id/uuid cabe de sobra). */
const MAX_METADATA_STRING_LENGTH = 120;

function assertSafeMetadata(metadata: AuditMetadata): void {
    for (const [key, value] of Object.entries(metadata)) {
        const type = typeof value;
        const isPrimitive =
            value === null || type === "string" || type === "number" || type === "boolean";
        if (!isPrimitive) {
            throw new AppError(
                "INVALID_INPUT",
                `La metadata de auditoría solo admite valores primitivos (clave: ${key}).`,
            );
        }
        if (type === "string" && (value as string).length > MAX_METADATA_STRING_LENGTH) {
            throw new AppError(
                "INVALID_INPUT",
                `La metadata de auditoría no admite textos largos (clave: ${key}).`,
            );
        }
    }
}

export interface AppEventRow {
    id: string;
    action: string;
    entity_type: string | null;
    entity_id: string | null;
    metadata: string | null;
    created_at: string;
}

/** Repositorio de eventos de auditoría. */
@injectable()
export class AuditRepository {
    constructor(@inject(DB) private readonly db: Database) {}

    /**
     * Registra un evento de auditoría.
     * @param action p. ej. "process.created", "candidate.analyzed"
     * @param metadata solo ids/contadores/duraciones (ver guard)
     */
    logEvent(
        action: string,
        entityType?: string,
        entityId?: string,
        metadata?: AuditMetadata,
    ): string {
        if (metadata) {
            assertSafeMetadata(metadata);
        }
        const id = newId();
        this.db
            .prepare(
                `INSERT INTO app_event (id, action, entity_type, entity_id, metadata)
                 VALUES (?, ?, ?, ?, ?)`,
            )
            .run(
                id,
                action,
                entityType ?? null,
                entityId ?? null,
                metadata ? JSON.stringify(metadata) : null,
            );
        return id;
    }

    /** Lista eventos por acción (útil para límites basados en conteo). */
    countByAction(action: string): number {
        const row = this.db
            .prepare("SELECT COUNT(*) AS total FROM app_event WHERE action = ?")
            .get(action) as { total: number };
        return row.total;
    }
}
