import { CreateModule, interfaces } from "@expressots/core";
import {
    CancelAnalysisUseCase,
    GetAnalysisUseCase,
    UpdateProposalUseCase,
} from "./get-analysis.usecase";
import { InterviewController } from "./interview.controller";
import { InterviewJobRegistry } from "./job-registry";
import { ProposalRepository } from "./proposal.repository";
import { RecordingRepository } from "./recording.repository";
import {
    DeleteRecordingUseCase,
    ListRecordingsUseCase,
} from "./recordings.usecase";
import { StartAnalysisUseCase } from "./start-analysis.usecase";

/**
 * Módulo del dominio Interview (BLUEPRINT §24).
 *
 * `InterviewJobRegistry` es singleton por obligación, no por comodidad: su
 * estado (el análisis en curso) vive en memoria, y con dos instancias el
 * límite de "un análisis a la vez" dejaría de existir.
 */
export const InterviewModule = CreateModule(
    [InterviewController],
    (bind: interfaces.Bind) => {
        bind(ProposalRepository).toSelf().inSingletonScope();
        bind(RecordingRepository).toSelf().inSingletonScope();
        bind(InterviewJobRegistry).toSelf().inSingletonScope();
        bind(StartAnalysisUseCase).toSelf().inSingletonScope();
        bind(GetAnalysisUseCase).toSelf().inSingletonScope();
        bind(CancelAnalysisUseCase).toSelf().inSingletonScope();
        bind(UpdateProposalUseCase).toSelf().inSingletonScope();
        bind(ListRecordingsUseCase).toSelf().inSingletonScope();
        bind(DeleteRecordingUseCase).toSelf().inSingletonScope();
    },
);
