import { injectable } from "@expressots/core";
import { AppError } from "../shared/errors";
import { RATE_LIMIT_WINDOW_MS } from "../shared/limits";

/**
 * Rate limiter local en memoria con ventana deslizante (BLUEPRINT §16).
 *
 * Aunque la app es local, estos límites evitan bloqueos y consumo excesivo
 * del modelo. Cada `key` (p. ej. "analyze") guarda los timestamps de sus
 * últimos usos; si en la ventana ya se alcanzó el límite, `check` lanza
 * AppError RATE_LIMITED sin registrar el intento.
 */
@injectable()
export class RateLimiter {
    private readonly hitsByKey = new Map<string, number[]>();

    /**
     * Registra un uso de `key` o lanza RATE_LIMITED si se alcanzó `limit`
     * dentro de la ventana (por defecto, una hora).
     */
    check(
        key: string,
        limit: number,
        windowMs: number = RATE_LIMIT_WINDOW_MS,
    ): void {
        const now = Date.now();
        const cutoff = now - windowMs;
        const recent = (this.hitsByKey.get(key) ?? []).filter(
            (t) => t > cutoff,
        );

        if (recent.length >= limit) {
            this.hitsByKey.set(key, recent);
            throw new AppError("RATE_LIMITED");
        }

        recent.push(now);
        this.hitsByKey.set(key, recent);
    }

    /** Vacía el estado (útil en tests). */
    reset(): void {
        this.hitsByKey.clear();
    }
}
