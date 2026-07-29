import { inject, injectable } from "@expressots/core";
import { Database, DB } from "../db/database";
import { AppError } from "../shared/errors";
import { newId } from "../shared/ids";

/**
 * Repositorio del proceso de selección (BLUEPRINT §12, §16).
 *
 * Invariante: solo puede existir UN proceso activo. Se comprueba en código
 * (usecases) y además lo fuerza la base de datos con el índice único parcial
 * `idx_process_single_active`; si dos escrituras compiten, la segunda recibe
 * la violación de unicidad y se traduce a ACTIVE_PROCESS_EXISTS.
 */

export interface ProcessRow {
    id: string;
    role_title: string;
    role_context: string | null;
    status: "active" | "closed";
    created_at: string;
    closed_at: string | null;
}

/** Campos editables del proceso activo. */
export interface ProcessUpdate {
    roleTitle?: string;
    roleContext?: string | null;
}

/** Conteos de filas eliminadas al purgar un proceso (para auditoría). */
export interface ProcessPurgeCounts {
    candidatesDeleted: number;
    scoresDeleted: number;
    questionsDeleted: number;
}

/** ¿Es una violación de unicidad de SQLite (índice único parcial incluido)? */
function isUniqueViolation(error: unknown): boolean {
    return (
        error instanceof Error &&
        "code" in error &&
        (error as { code?: string }).code === "SQLITE_CONSTRAINT_UNIQUE"
    );
}

/**
 * Devuelve el proceso activo o lanza NOT_FOUND. Compartido por los usecases
 * de process y de candidates (los candidatos siempre cuelgan del activo).
 */
export function requireActiveProcess(repository: ProcessRepository): ProcessRow {
    const active = repository.findActive();
    if (!active) {
        throw new AppError("NOT_FOUND", "No hay ningún proceso activo.");
    }
    return active;
}

@injectable()
export class ProcessRepository {
    constructor(@inject(DB) private readonly db: Database) {}

    findActive(): ProcessRow | undefined {
        return this.db
            .prepare("SELECT * FROM process WHERE status = 'active'")
            .get() as ProcessRow | undefined;
    }

    findById(id: string): ProcessRow | undefined {
        return this.db
            .prepare("SELECT * FROM process WHERE id = ?")
            .get(id) as ProcessRow | undefined;
    }

    /**
     * Crea un proceso activo. Si la base de datos detecta que ya hay uno
     * (índice único parcial), traduce el error a ACTIVE_PROCESS_EXISTS:
     * la DB es la última línea de defensa frente a carreras.
     */
    create(roleTitle: string, roleContext: string | null): ProcessRow {
        const id = newId();
        try {
            this.db
                .prepare(
                    "INSERT INTO process (id, role_title, role_context) VALUES (?, ?, ?)",
                )
                .run(id, roleTitle, roleContext);
        } catch (error) {
            if (isUniqueViolation(error)) {
                throw new AppError("ACTIVE_PROCESS_EXISTS");
            }
            throw error;
        }
        return this.findById(id) as ProcessRow;
    }

    /** Actualiza los campos editables del proceso indicado. */
    update(id: string, fields: ProcessUpdate): ProcessRow {
        const sets: string[] = [];
        const values: (string | null)[] = [];
        if (fields.roleTitle !== undefined) {
            sets.push("role_title = ?");
            values.push(fields.roleTitle);
        }
        if (fields.roleContext !== undefined) {
            sets.push("role_context = ?");
            values.push(fields.roleContext);
        }
        if (sets.length > 0) {
            this.db
                .prepare(`UPDATE process SET ${sets.join(", ")} WHERE id = ?`)
                .run(...values, id);
        }
        return this.findById(id) as ProcessRow;
    }

    /**
     * Purga un proceso: cuenta lo que va a desaparecer y borra la fila
     * `process`; las FK ON DELETE CASCADE arrastran candidatos, puntuaciones
     * y preguntas. Todo dentro de una transacción: o se borra todo o nada.
     *
     * Decisión (plan §Esquema SQL): la fila `process` NO se conserva como
     * traza; la única huella del proceso es el app_event que registra el
     * usecase con estos conteos.
     */
    purge(id: string): ProcessPurgeCounts {
        return this.db.transaction((): ProcessPurgeCounts => {
            const candidates = (
                this.db
                    .prepare("SELECT COUNT(*) AS total FROM candidate WHERE process_id = ?")
                    .get(id) as { total: number }
            ).total;
            const scores = (
                this.db
                    .prepare(
                        `SELECT COUNT(*) AS total FROM candidate_score cs
                         JOIN candidate c ON c.id = cs.candidate_id
                         WHERE c.process_id = ?`,
                    )
                    .get(id) as { total: number }
            ).total;
            const questions = (
                this.db
                    .prepare(
                        `SELECT COUNT(*) AS total FROM interview_question iq
                         JOIN candidate c ON c.id = iq.candidate_id
                         WHERE c.process_id = ?`,
                    )
                    .get(id) as { total: number }
            ).total;

            this.db.prepare("DELETE FROM process WHERE id = ?").run(id);

            return {
                candidatesDeleted: candidates,
                scoresDeleted: scores,
                questionsDeleted: questions,
            };
        })();
    }
}
