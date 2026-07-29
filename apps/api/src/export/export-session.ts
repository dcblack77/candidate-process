import { injectable } from "@expressots/core";

/**
 * Contador de exportaciones por sesión de proceso de la API (BLUEPRINT §16:
 * máximo 10 por sesión). Vive en memoria: reiniciar la API reinicia el
 * contador. Inyectable por DI para poder sustituirlo o resetearlo en tests.
 */
@injectable()
export class ExportSessionCounter {
    private used = 0;

    /** Exportaciones consumidas en esta sesión. */
    get count(): number {
        return this.used;
    }

    /** Registra una exportación y devuelve el total consumido. */
    increment(): number {
        this.used += 1;
        return this.used;
    }

    /** Vacía el contador (útil en tests). */
    reset(): void {
        this.used = 0;
    }
}
