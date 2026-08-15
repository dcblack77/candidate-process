import {
    body,
    controller,
    Http,
    Post,
    request,
} from "@expressots/adapter-express";
import { inject } from "@expressots/core";
import { Request } from "express";
import {
    canCompareCandidates,
    requirePermission,
} from "../security/permissions";
import { CompareCandidatesUseCase } from "./compare-candidates.usecase";
import { ComparisonResponseDTO } from "./comparison.dto";

/**
 * Ruta de la comparativa (BLUEPRINT §10, §21): POST /comparison.
 *
 * Es POST y no GET aunque no persista nada: la petición lleva una lista de
 * ids en el cuerpo y dispara una llamada al modelo local acotada por rate
 * limit (§16); no es una lectura barata ni cacheable. Responde 200 porque no
 * crea ningún recurso.
 *
 * Permisos (§09): canCompareCandidates, comprobado en backend.
 */
@controller("/comparison")
export class ComparisonController {
    constructor(
        @inject(CompareCandidatesUseCase)
        private readonly compareCandidates: CompareCandidatesUseCase,
    ) {}

    @Post("/")
    @Http(200)
    compare(
        @request() req: Request,
        @body() payload: unknown,
    ): Promise<ComparisonResponseDTO> {
        requirePermission(canCompareCandidates, req.currentUser);
        return this.compareCandidates.execute(payload);
    }
}
