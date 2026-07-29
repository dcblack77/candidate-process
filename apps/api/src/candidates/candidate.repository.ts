import { inject, injectable } from "@expressots/core";
import { Database, DB } from "../db/database";
import { newId } from "../shared/ids";

/**
 * Repositorio de candidatos (BLUEPRINT §12).
 *
 * - Borrado lógico: `deleted_at` marca al candidato como eliminado sin
 *   destruir la fila (el borrado físico llega con la purga del proceso).
 * - Todas las consultas "activas" filtran `deleted_at IS NULL`.
 * - `updated_at` se refresca en cada UPDATE.
 */

export type AnalysisStatus =
    | "pending"
    | "extracting"
    | "summarized"
    | "analyzing"
    | "analyzed"
    | "failed";

export interface CandidateRow {
    id: string;
    process_id: string;
    name: string;
    cv_summary: string | null;
    cv_evidence: string | null;
    analysis_status: AnalysisStatus;
    created_at: string;
    updated_at: string;
    deleted_at: string | null;
}

/** Refresco de updated_at en UTC ISO 8601, coherente con los DEFAULT del esquema. */
const NOW_UTC = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

@injectable()
export class CandidateRepository {
    constructor(@inject(DB) private readonly db: Database) {}

    /** Candidatos no borrados del proceso, en orden de alta. */
    listActive(processId: string): CandidateRow[] {
        return this.db
            .prepare(
                `SELECT * FROM candidate
                 WHERE process_id = ? AND deleted_at IS NULL
                 ORDER BY created_at, id`,
            )
            .all(processId) as CandidateRow[];
    }

    /** Cuántos candidatos no borrados tiene el proceso (límite §16). */
    countActive(processId: string): number {
        const row = this.db
            .prepare(
                "SELECT COUNT(*) AS total FROM candidate WHERE process_id = ? AND deleted_at IS NULL",
            )
            .get(processId) as { total: number };
        return row.total;
    }

    /**
     * Candidato no borrado perteneciente al proceso indicado. Devuelve
     * undefined si no existe, está soft-deleted o es de otro proceso:
     * los tres casos son NOT_FOUND para el cliente.
     */
    findActiveInProcess(id: string, processId: string): CandidateRow | undefined {
        return this.db
            .prepare(
                "SELECT * FROM candidate WHERE id = ? AND process_id = ? AND deleted_at IS NULL",
            )
            .get(id, processId) as CandidateRow | undefined;
    }

    create(processId: string, name: string): CandidateRow {
        const id = newId();
        this.db
            .prepare("INSERT INTO candidate (id, process_id, name) VALUES (?, ?, ?)")
            .run(id, processId, name);
        return this.db
            .prepare("SELECT * FROM candidate WHERE id = ?")
            .get(id) as CandidateRow;
    }

    rename(id: string, name: string): CandidateRow {
        this.db
            .prepare(`UPDATE candidate SET name = ?, updated_at = ${NOW_UTC} WHERE id = ?`)
            .run(name, id);
        return this.db
            .prepare("SELECT * FROM candidate WHERE id = ?")
            .get(id) as CandidateRow;
    }

    /**
     * Persiste la transición de estado de análisis (extracting/failed/…).
     * Solo el estado: nunca contenido del CV.
     */
    setAnalysisStatus(id: string, status: AnalysisStatus): void {
        this.db
            .prepare(
                `UPDATE candidate SET analysis_status = ?, updated_at = ${NOW_UTC} WHERE id = ?`,
            )
            .run(status, id);
    }

    /**
     * Persiste el RESULTADO del resumen (BLUEPRINT §04/§17): cv_summary es
     * el JSON completo devuelto por el modelo y cv_evidence su sub-objeto
     * `evidence`. El texto extraído del CV NUNCA se guarda.
     */
    saveCvSummary(id: string, cvSummaryJson: string, cvEvidenceJson: string): void {
        this.db
            .prepare(
                `UPDATE candidate
                 SET cv_summary = ?, cv_evidence = ?, analysis_status = 'summarized',
                     updated_at = ${NOW_UTC}
                 WHERE id = ?`,
            )
            .run(cvSummaryJson, cvEvidenceJson, id);
    }

    /** Borrado lógico: marca deleted_at (y updated_at) sin destruir datos. */
    softDelete(id: string): void {
        this.db
            .prepare(
                `UPDATE candidate SET deleted_at = ${NOW_UTC}, updated_at = ${NOW_UTC} WHERE id = ?`,
            )
            .run(id);
    }
}
