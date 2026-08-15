import { injectable } from "@expressots/core";
import { AppErrorCode } from "../shared/errors";
import { newId } from "../shared/ids";

/**
 * Registro EN MEMORIA de la carga masiva de CVs en curso (BLUEPRINT §16,
 * carga masiva 2026-08-15).
 *
 * Por qué un job y no un request largo: resumir un CV con el modelo local
 * son segundos, y treinta seguidos son minutos; ningún request HTTP debe
 * vivir tanto (Node corta a los 5 min y el navegador antes). El request
 * hace todo lo que es rápido y tiene que morir con él —validar, crear los
 * candidatos y EXTRAER el texto de cada archivo— y responde 202; el job
 * solo va pasando ese texto por el modelo, uno a uno.
 *
 * Por qué en memoria: el único dato que el job retiene es el texto extraído
 * de cada CV hasta que el modelo lo resume, y ese texto NO se persiste
 * jamás (§04/§17). Un reinicio del backend a mitad de lote pierde el job y
 * el texto, no los candidatos: los ya resumidos quedan `summarized` y los que
 * faltaban quedan `pending`, listos para una subida individual.
 *
 * Solo un lote a la vez: la cola del modelo es de concurrencia 1, así que un
 * segundo lote simultáneo no iría más rápido, solo haría más confuso el
 * progreso.
 */

export type BulkImportJobStatus = "running" | "done" | "failed" | "cancelled";

/**
 * Estado de cada archivo del lote.
 * - `rejected`: formato no admitido; NO se creó candidato.
 * - `queued` → `summarizing` → `summarized` | `failed`.
 * - `skipped`: al llegarle el turno alguien ya había subido un CV a mano a
 *   ese candidato; el job no pisa ese trabajo.
 * - `cancelled`: el lote se canceló (o el modelo dejó de responder) antes de
 *   llegarle el turno; su candidato sigue `pending`.
 */
export type BulkImportItemStatus =
    | "rejected"
    | "queued"
    | "summarizing"
    | "summarized"
    | "failed"
    | "skipped"
    | "cancelled";

export interface BulkImportItem {
    /** Posición del archivo en la subida (0-based): la UI casa por aquí. */
    index: number;
    candidateId: string | null;
    name: string | null;
    status: BulkImportItemStatus;
    errorCode: AppErrorCode | null;
    extractedChars: number | null;
    truncated: boolean | null;
    /** Veces que se esperó al modelo caído antes de resumir este CV. */
    llmWaits: number;
    /**
     * Texto extraído del CV, SOLO hasta que el modelo lo resume (o el job lo
     * descarta). Nunca sale en el DTO, nunca se persiste, nunca se loguea.
     */
    text: string | null;
}

export interface BulkImportJob {
    id: string;
    processId: string;
    status: BulkImportJobStatus;
    startedAt: string;
    finishedAt: string | null;
    /** Solo cuando el job entero se detiene (modelo caído). */
    errorCode: AppErrorCode | null;
    /**
     * Cancelación pedida: lo que faltaba ya está `cancelled`, pero el job
     * sigue `running` hasta que el CV que estaba en el modelo termina. Así la
     * UI puede seguir haciendo polling hasta que no quede nada en vuelo.
     */
    cancelRequested: boolean;
    items: BulkImportItem[];
}

/** Cuánto sobrevive un job terminado antes de olvidarse. */
const COMPLETED_TTL_MS = 15 * 60 * 1000;

@injectable()
export class BulkImportJobRegistry {
    private jobs = new Map<string, BulkImportJob>();

    /**
     * Reserva el job (vacío) y lo marca en curso. Devuelve `null` si ya hay
     * otro vivo: el llamador lo traduce a LIMIT_EXCEEDED con mensaje propio.
     * Se reserva ANTES de crear candidatos para que dos lotes simultáneos no
     * pasen ambos la comprobación.
     */
    start(processId: string): BulkImportJob | null {
        this.forgetExpired();
        if (this.active()) {
            return null;
        }
        const job: BulkImportJob = {
            id: newId(),
            processId,
            status: "running",
            startedAt: new Date().toISOString(),
            finishedAt: null,
            errorCode: null,
            cancelRequested: false,
            items: [],
        };
        this.jobs.set(job.id, job);
        return job;
    }

    /** El job en curso, si lo hay. */
    active(): BulkImportJob | undefined {
        return [...this.jobs.values()].find((job) => job.status === "running");
    }

    find(id: string): BulkImportJob | undefined {
        this.forgetExpired();
        return this.jobs.get(id);
    }

    /**
     * Libera un job reservado cuya preparación falló antes de arrancar
     * (límite de candidatos, cupo por hora…). No deja rastro: el cliente
     * recibe el error y puede volver a intentarlo enseguida.
     */
    discard(id: string): void {
        this.jobs.delete(id);
    }

    /** Termina el job: `done`, o `cancelled` si se había pedido cancelar. */
    finish(id: string): void {
        const job = this.jobs.get(id);
        if (!job || job.status !== "running") {
            return;
        }
        job.status = job.cancelRequested ? "cancelled" : "done";
        job.finishedAt = new Date().toISOString();
    }

    /** Detiene el job entero (modelo caído) marcando lo que quedaba. */
    fail(id: string, errorCode: AppErrorCode): void {
        const job = this.jobs.get(id);
        if (!job || job.status !== "running") {
            return;
        }
        job.status = "failed";
        job.errorCode = errorCode;
        job.finishedAt = new Date().toISOString();
        dropQueued(job);
    }

    /**
     * Pide cancelar un job. Los que faltaban quedan `cancelled` con su
     * candidato en `pending` de inmediato; el CV que esté en el modelo en ese
     * momento termina (la llamada no se puede abortar) y entonces el bucle
     * cierra el job como `cancelled`.
     */
    cancel(id: string): BulkImportJob | undefined {
        const job = this.jobs.get(id);
        if (!job || job.status !== "running") {
            return job;
        }
        job.cancelRequested = true;
        dropQueued(job);
        return job;
    }

    /** Olvida los jobs terminados hace rato. Evita que la memoria crezca. */
    private forgetExpired(): void {
        const now = Date.now();
        for (const [id, job] of this.jobs) {
            if (
                job.status !== "running" &&
                job.finishedAt !== null &&
                now - Date.parse(job.finishedAt) > COMPLETED_TTL_MS
            ) {
                this.jobs.delete(id);
            }
        }
    }
}

/** Lo que aún no había empezado pasa a `cancelled` y suelta su texto. */
function dropQueued(job: BulkImportJob): void {
    for (const item of job.items) {
        if (item.status === "queued") {
            item.status = "cancelled";
            item.text = null;
        }
    }
}
