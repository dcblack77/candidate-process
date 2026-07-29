import { inject, injectable } from "@expressots/core";
import { ProcessResponseDTO, toProcessResponse } from "./process.dto";
import { ProcessRepository, requireActiveProcess } from "./process.repository";

/** GET /process — devuelve el proceso activo o NOT_FOUND si no hay. */
@injectable()
export class GetProcessUseCase {
    constructor(
        @inject(ProcessRepository) private readonly processes: ProcessRepository,
    ) {}

    execute(): ProcessResponseDTO {
        return toProcessResponse(requireActiveProcess(this.processes));
    }
}
