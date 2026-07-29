import { controller, Get, request } from "@expressots/adapter-express";
import { inject } from "@expressots/core";
import { Request } from "express";
import { canViewRanking, requirePermission } from "../security/permissions";
import { GetRankingUseCase } from "./get-ranking.usecase";
import { RankingResponseDTO } from "./ranking.dto";

/**
 * Ruta del ranking (BLUEPRINT §10 y §15): GET /ranking.
 */
@controller("/ranking")
export class RankingController {
    constructor(
        @inject(GetRankingUseCase)
        private readonly getRanking: GetRankingUseCase,
    ) {}

    @Get("/")
    ranking(@request() req: Request): RankingResponseDTO {
        requirePermission(canViewRanking, req.currentUser);
        return this.getRanking.execute();
    }
}
