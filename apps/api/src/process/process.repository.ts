import { inject, injectable } from "@expressots/core";
import { Database, DB } from "../db/database";
import { AppError } from "../shared/errors";
import { newId } from "../shared/ids";

/**
 * Repositorio del proceso de selección (BLUEPRINT §12, §16).
 *
 * Desde 2026-08-07 puede haber VARIOS procesos abiertos a la vez. Lo que es
 * único es el proceso SELECCIONADO (`is_current`), que determina sobre qué
 * proceso operan candidatos, análisis, ranking y export.
 *
 * La selección es estado de servidor compartido por todos los clientes
 * (decisión explícita del usuario): si alguien cambia de proceso desde otro
 * equipo de la LAN, cambia para todos. La unicidad la fuerza el índice
 * parcial `idx_process_single_current`; que no haya ninguno seleccionado es
 * un estado válido (base vacía, o se borró el que estaba seleccionado).
 */

export interface ProcessRow {
    id: string;
    role_title: string;
    role_context: string | null;
    status: "active" | "closed";
    created_at: string;
    closed_at: string | null;
    /** 1 si es el proceso seleccionado; 0 en el resto. */
    is_current: number;
}

/** Fila de la lista de procesos: incluye cuántos candidatos vivos tiene. */
export interface ProcessListRow extends ProcessRow {
    candidate_count: number;
}

/** Campos editables de un proceso. */
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

/**
 * Devuelve el proceso SELECCIONADO o lanza NOT_FOUND. Lo usan los usecases
 * de solo lectura (listar candidatos, ranking, export): un proceso archivado
 * se puede consultar con normalidad.
 */
export function requireCurrentProcess(
    repository: ProcessRepository,
): ProcessRow {
    const current = repository.findCurrent();
    if (!current) {
        throw new AppError(
            "NOT_FOUND",
            "No hay ningún proceso seleccionado.",
        );
    }
    return current;
}

/**
 * Igual que `requireCurrentProcess` pero además exige que el proceso admita
 * escrituras. Un proceso archivado (status='closed') conserva sus datos en
 * SOLO LECTURA: añadir candidatos, analizar, puntuar o anotar sobre él se
 * rechaza con PROCESS_CLOSED (409).
 *
 * Lo usan todos los usecases que mutan datos; la comprobación va en backend
 * y no depende de que la UI oculte botones (§09).
 */
export function requireWritableProcess(
    repository: ProcessRepository,
): ProcessRow {
    const current = requireCurrentProcess(repository);
    if (current.status === "closed") {
        throw new AppError("PROCESS_CLOSED");
    }
    return current;
}

@injectable()
export class ProcessRepository {
    constructor(@inject(DB) private readonly db: Database) {}

    /** El proceso seleccionado, sea cual sea su estado. */
    findCurrent(): ProcessRow | undefined {
        return this.db
            .prepare("SELECT * FROM process WHERE is_current = 1")
            .get() as ProcessRow | undefined;
    }

    findById(id: string): ProcessRow | undefined {
        return this.db.prepare("SELECT * FROM process WHERE id = ?").get(id) as
            | ProcessRow
            | undefined;
    }

    /**
     * Todos los procesos, con el número de candidatos vivos de cada uno.
     * Orden: abiertos antes que archivados y, dentro de cada grupo, el más
     * reciente primero (es el que se suele querer retomar).
     */
    listAll(): ProcessListRow[] {
        return this.db
            .prepare(
                `SELECT p.*,
                        (SELECT COUNT(*) FROM candidate c
                          WHERE c.process_id = p.id AND c.deleted_at IS NULL)
                        AS candidate_count
                   FROM process p
                  ORDER BY (p.status = 'closed'), p.created_at DESC`,
            )
            .all() as ProcessListRow[];
    }

    /**
     * Crea un proceso abierto y lo deja seleccionado. Ya no falla si hay
     * otros procesos abiertos: ese era el invariante que este cambio deroga.
     */
    create(roleTitle: string, roleContext: string | null): ProcessRow {
        const id = newId();
        this.db.transaction(() => {
            this.clearCurrent();
            this.db
                .prepare(
                    `INSERT INTO process (id, role_title, role_context, is_current)
                     VALUES (?, ?, ?, 1)`,
                )
                .run(id, roleTitle, roleContext);
        })();
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
     * Marca `id` como proceso seleccionado. El deseleccionar-y-seleccionar va
     * en una transacción porque el índice único parcial rechazaría el estado
     * intermedio con dos filas a 1.
     */
    select(id: string): ProcessRow {
        this.db.transaction(() => {
            this.clearCurrent();
            this.db
                .prepare("UPDATE process SET is_current = 1 WHERE id = ?")
                .run(id);
        })();
        return this.findById(id) as ProcessRow;
    }

    /**
     * Archiva un proceso: status='closed' + closed_at. Los datos derivados
     * (candidatos, puntuaciones, preguntas, notas) se CONSERVAN en solo
     * lectura; el borrado es una acción aparte (`purge`).
     */
    close(id: string): ProcessRow {
        this.db
            .prepare(
                `UPDATE process
                    SET status = 'closed',
                        closed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                  WHERE id = ?`,
            )
            .run(id);
        return this.findById(id) as ProcessRow;
    }

    /** Reabre un proceso archivado: vuelve a admitir escrituras. */
    reopen(id: string): ProcessRow {
        this.db
            .prepare(
                "UPDATE process SET status = 'active', closed_at = NULL WHERE id = ?",
            )
            .run(id);
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
     *
     * Si el proceso borrado era el seleccionado, pasa a estarlo el proceso
     * más reciente que quede (o ninguno, si era el último): así la app nunca
     * queda apuntando a un proceso inexistente.
     */
    purge(id: string): ProcessPurgeCounts {
        return this.db.transaction((): ProcessPurgeCounts => {
            const candidates = (
                this.db
                    .prepare(
                        "SELECT COUNT(*) AS total FROM candidate WHERE process_id = ?",
                    )
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

            const wasCurrent =
                (this.findById(id)?.is_current ?? 0) === 1;

            this.db.prepare("DELETE FROM process WHERE id = ?").run(id);

            if (wasCurrent) {
                const fallback = this.db
                    .prepare(
                        `SELECT id FROM process
                          ORDER BY (status = 'closed'), created_at DESC
                          LIMIT 1`,
                    )
                    .get() as { id: string } | undefined;
                if (fallback) {
                    this.db
                        .prepare(
                            "UPDATE process SET is_current = 1 WHERE id = ?",
                        )
                        .run(fallback.id);
                }
            }

            return {
                candidatesDeleted: candidates,
                scoresDeleted: scores,
                questionsDeleted: questions,
            };
        })();
    }

    /** Deja la selección vacía. Siempre dentro de una transacción. */
    private clearCurrent(): void {
        this.db.prepare("UPDATE process SET is_current = 0 WHERE is_current = 1").run();
    }
}
