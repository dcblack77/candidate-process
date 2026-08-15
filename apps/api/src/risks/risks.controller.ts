import {
    controller,
    Get,
    Http,
    param,
    Post,
    request,
} from "@expressots/adapter-express";
import { inject } from "@expressots/core";
import { Request } from "express";
import {
    canAnalyzeCandidate,
    canViewRanking,
    requirePermission,
} from "../security/permissions";
import { DetectRisksUseCase } from "./detect-risks.usecase";
import { GetRisksUseCase } from "./get-risks.usecase";
import { DetectRisksResponseDTO, GetRisksResponseDTO } from "./risks.dto";

/**
 * Rutas de riesgos y lagunas (BLUEPRINT §10, §13):
 * POST /candidates/:id/risks (detecta con el modelo y persiste) y
 * GET  /candidates/:id/risks (la última detección persistida).
 *
 * Permisos (§09): detectar es análisis del candidato (canAnalyzeCandidate);
 * consultar es lectura de evaluación, como el ranking (canViewRanking).
 */
@controller("/candidates")
export class RisksController {
    constructor(
        @inject(DetectRisksUseCase)
        private readonly detectRisks: DetectRisksUseCase,
        @inject(GetRisksUseCase)
        private readonly getRisks: GetRisksUseCase,
    ) {}

    @Post("/:id/risks")
    @Http(200)
    detect(
        @request() req: Request,
        @param("id") id: string,
    ): Promise<DetectRisksResponseDTO> {
        requirePermission(canAnalyzeCandidate, req.currentUser);
        return this.detectRisks.execute(id);
    }

    @Get("/:id/risks")
    @Http(200)
    get(@request() req: Request, @param("id") id: string): GetRisksResponseDTO {
        requirePermission(canViewRanking, req.currentUser);
        return this.getRisks.execute(id);
    }
}
