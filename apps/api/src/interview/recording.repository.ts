import { inject, injectable } from "@expressots/core";
import { Database, DB } from "../db/database";
import { StoredTrack } from "./recording-store";

/**
 * Repositorio de grabaciones de entrevista (BLUEPRINT §24, migración 006).
 *
 * Es un ÍNDICE, no el contenido: el audio y la transcripción son archivos
 * bajo `RECORDINGS_DIR` y aquí solo vive la referencia. Consecuencia práctica
 * a tener presente en cada borrado: las filas se van solas por el CASCADE,
 * los archivos NO. Quien borre filas tiene que haber borrado antes el disco.
 */

/** Estado del último análisis lanzado sobre una grabación. */
export type RecordingRunStatus = "running" | "done" | "failed" | "cancelled";

export interface RecordingRow {
    id: string;
    candidate_id: string;
    process_id: string;
    candidate_source: "mic" | "tab";
    /** JSON `StoredTrack[]`. Usa {@link parseTracks} para leerlo. */
    tracks: string;
    transcript_at: string | null;
    duration_sec: number | null;
    segments: number | null;
    last_run_id: string | null;
    last_status: RecordingRunStatus | null;
    last_error_code: string | null;
    created_at: string;
}

export interface CreateRecordingInput {
    /**
     * Id de la grabación. Lo elige el llamador y NO se genera aquí: el
     * directorio en disco se crea antes que la fila y tiene que llamarse
     * igual, o el audio y la transcripción acabarían en sitios distintos.
     */
    id: string;
    candidateId: string;
    processId: string;
    candidateSource: "mic" | "tab";
    tracks: StoredTrack[];
    runId: string;
}

/**
 * Lee la columna `tracks`. Si el JSON está corrupto devuelve una lista vacía
 * en vez de reventar: el llamador lo traduce a "esta grabación ya no sirve",
 * que es más útil que un 500 en mitad de la pantalla del candidato.
 */
export function parseTracks(row: RecordingRow): StoredTrack[] {
    try {
        const parsed: unknown = JSON.parse(row.tracks);
        return Array.isArray(parsed) ? (parsed as StoredTrack[]) : [];
    } catch {
        return [];
    }
}

@injectable()
export class RecordingRepository {
    constructor(@inject(DB) private readonly db: Database) {}

    /**
     * Registra una grabación recién guardada en disco. Nace ya con el job
     * asociado y en `running`: si el proceso muere en el siguiente segundo,
     * la fila queda como "running que nunca terminó", que es exactamente la
     * traza que hacía falta para saber que algo falló.
     */
    create(input: CreateRecordingInput): RecordingRow {
        const { id } = input;
        this.db
            .prepare(
                `INSERT INTO interview_recording
                    (id, candidate_id, process_id, candidate_source, tracks,
                     last_run_id, last_status)
                 VALUES (?, ?, ?, ?, ?, ?, 'running')`,
            )
            .run(
                id,
                input.candidateId,
                input.processId,
                input.candidateSource,
                JSON.stringify(input.tracks),
                input.runId,
            );
        return this.findById(id) as RecordingRow;
    }

    findById(id: string): RecordingRow | undefined {
        return this.db
            .prepare("SELECT * FROM interview_recording WHERE id = ?")
            .get(id) as RecordingRow | undefined;
    }

    findByIdForCandidate(
        id: string,
        candidateId: string,
    ): RecordingRow | undefined {
        return this.db
            .prepare(
                "SELECT * FROM interview_recording WHERE id = ? AND candidate_id = ?",
            )
            .get(id, candidateId) as RecordingRow | undefined;
    }

    /** Grabaciones de un candidato, la más reciente primero. */
    listByCandidate(candidateId: string): RecordingRow[] {
        return this.db
            .prepare(
                `SELECT * FROM interview_recording
                  WHERE candidate_id = ?
                  ORDER BY created_at DESC`,
            )
            .all(candidateId) as RecordingRow[];
    }

    countByCandidate(candidateId: string): number {
        return (
            this.db
                .prepare(
                    "SELECT COUNT(*) AS total FROM interview_recording WHERE candidate_id = ?",
                )
                .get(candidateId) as { total: number }
        ).total;
    }

    /**
     * Grabaciones de un proceso. Se usa para borrar sus archivos ANTES de
     * purgar el proceso: cuando el CASCADE se lleva las filas ya no hay forma
     * de saber qué directorios quedaron huérfanos en disco.
     */
    listByProcess(processId: string): RecordingRow[] {
        return this.db
            .prepare("SELECT * FROM interview_recording WHERE process_id = ?")
            .all(processId) as RecordingRow[];
    }

    /** Anota que la transcripción ya está en disco y es reutilizable. */
    markTranscribed(id: string, durationSec: number, segments: number): void {
        this.db
            .prepare(
                `UPDATE interview_recording
                    SET transcript_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
                        duration_sec = ?,
                        segments = ?
                  WHERE id = ?`,
            )
            .run(durationSec, segments, id);
    }

    /**
     * Actualiza cómo acabó el último análisis. `errorCode` es el código
     * tipado de AppError, nunca el mensaje (§17).
     */
    markRun(
        id: string,
        runId: string,
        status: RecordingRunStatus,
        errorCode: string | null = null,
    ): void {
        this.db
            .prepare(
                `UPDATE interview_recording
                    SET last_run_id = ?, last_status = ?, last_error_code = ?
                  WHERE id = ?`,
            )
            .run(runId, status, errorCode, id);
    }

    /** Borra la fila. Los archivos son responsabilidad del llamador. */
    delete(id: string): void {
        this.db
            .prepare("DELETE FROM interview_recording WHERE id = ?")
            .run(id);
    }
}
