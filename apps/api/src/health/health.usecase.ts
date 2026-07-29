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
}

/** Tiempo máximo de espera del ping al modelo local (ms). */
const LLM_PING_TIMEOUT_MS = 1500;

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
            llm: await this.checkLlm(),
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

    /**
     * Ping al modelo local (llama.cpp, API OpenAI-compatible). Si el modelo
     * está caído o tarda más de 1,5 s, el health NO falla: solo reporta
     * `llm: false`.
     */
    private async checkLlm(): Promise<boolean> {
        try {
            const response = await fetch(`${this.env.LLM_BASE_URL}/v1/models`, {
                signal: AbortSignal.timeout(LLM_PING_TIMEOUT_MS),
            });
            return response.ok;
        } catch {
            return false;
        }
    }
}
