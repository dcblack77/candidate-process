import { controller, Get } from "@expressots/adapter-express";
import { inject } from "@expressots/core";
import { HealthResponseDTO, HealthUseCase } from "./health.usecase";

/**
 * GET /health — estado de la API, la base de datos y el modelo local.
 * Controller de referencia: delega toda la lógica en su usecase.
 * Patrón: DI por constructor SIEMPRE con @inject explícito (tsx/esbuild
 * no emiten design:paramtypes, así que la inyección por tipo no funciona).
 *
 * Nota: /health no exige permisos porque no expone datos de candidatos
 * (BLUEPRINT §10 lo lista fuera del área protegida).
 */
@controller("/health")
export class HealthController {
    constructor(
        @inject(HealthUseCase) private readonly healthUseCase: HealthUseCase,
    ) {}

    @Get("/")
    async health(): Promise<HealthResponseDTO> {
        return this.healthUseCase.execute();
    }
}
