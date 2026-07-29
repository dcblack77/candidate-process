import {
    body,
    controller,
    Http,
    Post,
    request,
} from "@expressots/adapter-express";
import { inject } from "@expressots/core";
import { Request } from "express";
import { canExportResults, requirePermission } from "../security/permissions";
import { ExportResponseDTO } from "./export.dto";
import { ExportUseCase } from "./export.usecase";

/**
 * Ruta de exportación (BLUEPRINT §10 y §19): POST /export.
 */
@controller("/export")
export class ExportController {
    constructor(
        @inject(ExportUseCase) private readonly exportResults: ExportUseCase,
    ) {}

    @Post("/")
    @Http(200)
    export(
        @request() req: Request,
        @body() payload: unknown,
    ): ExportResponseDTO {
        requirePermission(canExportResults, req.currentUser);
        return this.exportResults.execute(payload);
    }
}
