import {
    body,
    controller,
    Delete,
    Get,
    Http,
    param,
    Patch,
    Post,
    request,
} from "@expressots/adapter-express";
import { inject } from "@expressots/core";
import { Request } from "express";
import {
    canCreateCandidate,
    canDeleteData,
    requirePermission,
} from "../security/permissions";
import {
    CandidateDeleteResponseDTO,
    CandidateDetailDTO,
    CandidateListItemDTO,
} from "./candidate.dto";
import { CreateCandidateUseCase } from "./create-candidate.usecase";
import { DeleteCandidateUseCase } from "./delete-candidate.usecase";
import { GetCandidateUseCase } from "./get-candidate.usecase";
import { ListCandidatesUseCase } from "./list-candidates.usecase";
import { RenameCandidateUseCase } from "./rename-candidate.usecase";

/**
 * Rutas de candidatos (BLUEPRINT §10). Todas cuelgan del proceso seleccionado.
 *
 * Permisos (§09): lectura/alta/edición usan canCreateCandidate (gestión de
 * candidatos); el borrado usa canDeleteData. Siempre validados en backend.
 */
@controller("/candidates")
export class CandidatesController {
    constructor(
        @inject(ListCandidatesUseCase)
        private readonly listCandidates: ListCandidatesUseCase,
        @inject(CreateCandidateUseCase)
        private readonly createCandidate: CreateCandidateUseCase,
        @inject(GetCandidateUseCase)
        private readonly getCandidate: GetCandidateUseCase,
        @inject(RenameCandidateUseCase)
        private readonly renameCandidate: RenameCandidateUseCase,
        @inject(DeleteCandidateUseCase)
        private readonly deleteCandidate: DeleteCandidateUseCase,
    ) {}

    @Get("/")
    list(@request() req: Request): CandidateListItemDTO[] {
        requirePermission(canCreateCandidate, req.currentUser);
        return this.listCandidates.execute();
    }

    @Post("/")
    @Http(201)
    create(
        @request() req: Request,
        @body() payload: unknown,
    ): CandidateListItemDTO {
        requirePermission(canCreateCandidate, req.currentUser);
        return this.createCandidate.execute(payload);
    }

    @Get("/:id")
    detail(
        @request() req: Request,
        @param("id") id: string,
    ): CandidateDetailDTO {
        requirePermission(canCreateCandidate, req.currentUser);
        return this.getCandidate.execute(id);
    }

    @Patch("/:id")
    @Http(200)
    rename(
        @request() req: Request,
        @param("id") id: string,
        @body() payload: unknown,
    ): CandidateListItemDTO {
        requirePermission(canCreateCandidate, req.currentUser);
        return this.renameCandidate.execute(id, payload);
    }

    @Delete("/:id")
    @Http(200)
    remove(
        @request() req: Request,
        @param("id") id: string,
    ): CandidateDeleteResponseDTO {
        requirePermission(canDeleteData, req.currentUser);
        return this.deleteCandidate.execute(id);
    }
}
