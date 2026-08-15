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

    /**
     * Reserva `count` usos de `key` DE UNA VEZ o lanza RATE_LIMITED sin
     * registrar ninguno. Lo usa la carga masiva de CVs: un lote de N archivos
     * son N extracciones (§16) y, si no caben todas en la ventana, se rechaza
     * el lote entero antes de crear nada en vez de dejar a medias.
     */
    checkMany(
        key: string,
        limit: number,
        count: number,
        windowMs: number = RATE_LIMIT_WINDOW_MS,
    ): void {
        const now = Date.now();
        const cutoff = now - windowMs;
        const recent = (this.hitsByKey.get(key) ?? []).filter(
            (t) => t > cutoff,
        );

        if (recent.length + count > limit) {
            this.hitsByKey.set(key, recent);
            throw new AppError("RATE_LIMITED");
        }

        for (let i = 0; i < count; i++) {
            recent.push(now);
        }
        this.hitsByKey.set(key, recent);
    }

    /**
     * Devuelve el último uso registrado de `key`, si lo hay dentro de la
     * ventana. Para cuando la acción NO llegó a consumir lo que el límite
     * protege: un análisis de entrevista cancelado antes de arrancar o caído
     * porque el servicio de transcripción no estaba. Sin esto, seis fallos de
     * infraestructura seguidos dejaban al usuario una hora sin poder
     * reintentar sobre una entrevista que ya había ocurrido (§24).
     */
    refund(key: string): void {
        const recent = this.hitsByKey.get(key);
        if (!recent || recent.length === 0) {
            return;
        }
        recent.pop();
        this.hitsByKey.set(key, recent);
    }
}
