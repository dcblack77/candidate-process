import { injectable } from "@expressots/core";
import { RATE_LIMIT_WINDOW_MS } from "../shared/limits";

/**
 * Contador de exportaciones de la "sesión" (BLUEPRINT §16: máximo 10).
 *
 * Desde el 2026-08-15 la sesión es una **ventana deslizante de una hora**, no
 * la vida del proceso de la API. Antes el contador solo subía, así que a la
 * undécima exportación la única salida era reiniciar el servidor: sin login no
 * existe otra "sesión" que esa y el límite se convertía en un reinicio. La
 * ventana horaria sigue acotando el abuso accidental —que es lo que §16
 * persigue— sin ese peaje. Sigue en memoria y sigue siendo inyectable para
 * sustituirlo o resetearlo en tests.
 */
@injectable()
export class ExportSessionCounter {
    private hits: number[] = [];

    /** Exportaciones consumidas dentro de la ventana actual. */
    get count(): number {
        this.forgetExpired();
        return this.hits.length;
    }

    /** Registra una exportación y devuelve el total consumido en la ventana. */
    increment(): number {
        this.forgetExpired();
        this.hits.push(Date.now());
        return this.hits.length;
    }

    /** Vacía el contador (útil en tests). */
    reset(): void {
        this.hits = [];
    }

    private forgetExpired(): void {
        const cutoff = Date.now() - RATE_LIMIT_WINDOW_MS;
        this.hits = this.hits.filter((t) => t > cutoff);
    }
}
