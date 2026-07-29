import { CreateModule, interfaces } from "@expressots/core";
import { CandidateRepository } from "./candidate.repository";
import { CandidatesController } from "./candidates.controller";
import { CreateCandidateUseCase } from "./create-candidate.usecase";
import { DeleteCandidateUseCase } from "./delete-candidate.usecase";
import { GetCandidateUseCase } from "./get-candidate.usecase";
import { ListCandidatesUseCase } from "./list-candidates.usecase";
import { RenameCandidateUseCase } from "./rename-candidate.usecase";

/**
 * Módulo del dominio Candidates. Depende de ProcessRepository (bindeado en
 * ProcessModule, mismo contenedor): un candidato solo existe dentro del
 * proceso activo.
 */
export const CandidatesModule = CreateModule(
    [CandidatesController],
    (bind: interfaces.Bind) => {
        bind(CandidateRepository).toSelf().inSingletonScope();
        bind(ListCandidatesUseCase).toSelf().inSingletonScope();
        bind(CreateCandidateUseCase).toSelf().inSingletonScope();
        bind(GetCandidateUseCase).toSelf().inSingletonScope();
        bind(RenameCandidateUseCase).toSelf().inSingletonScope();
        bind(DeleteCandidateUseCase).toSelf().inSingletonScope();
    },
);
