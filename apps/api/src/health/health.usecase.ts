import { inject, injectable } from "@expressots/core";
import { Database, DB } from "../db/database";
import { AppEnv, ENV } from "../env";

/**
 * Caso de uso de /health. Sirve además como patrón de referencia para el
 * resto de módulos: clase @injectable con dependencias por constructor
 * (tokens DI) y un método `execute` que devuelve el DTO de respuesta.
 */

export interface HealthResponseDTO {
    status: "ok";
    db: boolean;
    llm: boolean;
    /** Servicio local de transcripción (§24, contenedor `voice-stt`). */
    stt: boolean;
}

/** Tiempo máximo de espera de los pings a los servicios locales (ms). */
const PING_TIMEOUT_MS = 1500;

@injectable()
export class HealthUseCase {
    constructor(
        @inject(DB) private readonly db: Database,
        @inject(ENV) private readonly env: AppEnv,
    ) {}

    async execute(): Promise<HealthResponseDTO> {
        return {
            status: "ok",
            db: this.checkDb(),
            // En paralelo: dos servicios distintos, y el health no debe tardar
            // la suma de los dos timeouts.
            ...(await this.checkServices()),
        };
    }

    private checkDb(): boolean {
        try {
            this.db.prepare("SELECT 1").get();
            return true;
        } catch {
            return false;
        }
    }

    private async checkServices(): Promise<{ llm: boolean; stt: boolean }> {
        const [llm, stt] = await Promise.all([
            this.ping(this.env.LLM_BASE_URL),
            this.ping(this.env.STT_BASE_URL),
        ]);
        return { llm, stt };
    }

    /**
     * Ping a un servicio local con API OpenAI-compatible. Si está caído o
     * tarda más de 1,5 s, el health NO falla: solo reporta `false`. Que la
     * transcripción esté caída lo tiene que ver la UI ANTES de que alguien
     * grabe cincuenta minutos para nada.
     */
    private async ping(baseUrl: string): Promise<boolean> {
        try {
            const response = await fetch(`${baseUrl}/v1/models`, {
                signal: AbortSignal.timeout(PING_TIMEOUT_MS),
            });
            return response.ok;
        } catch {
            return false;
        }
    }
}
