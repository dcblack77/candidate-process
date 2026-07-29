import {
    controller,
    Http,
    param,
    Post,
    request,
} from "@expressots/adapter-express";
import { inject } from "@expressots/core";
import { Request } from "express";
import { canUploadCV, requirePermission } from "../security/permissions";
import { CvExtractResponseDTO } from "./cv.dto";
import { ExtractCvUseCase } from "./extract-cv.usecase";
import { scrubUploadedFile, uploadCvMiddleware } from "./upload.middleware";

/**
 * Dominio CV (BLUEPRINT §10): POST /candidates/:id/cv/extract.
 *
 * El archivo llega por multipart (campo `file`) a memoria vía
 * uploadCvMiddleware; pase lo que pase, el finally anula las referencias al
 * buffer: el CV original nunca se persiste ni se sirve desde ninguna ruta.
 */
@controller("/candidates")
export class CvController {
    constructor(
        @inject(ExtractCvUseCase) private readonly extractCv: ExtractCvUseCase,
    ) {}

    @Post("/:id/cv/extract", uploadCvMiddleware)
    @Http(200)
    async extract(
        @request() req: Request,
        @param("id") id: string,
    ): Promise<CvExtractResponseDTO> {
        try {
            requirePermission(canUploadCV, req.currentUser);
            return await this.extractCv.execute(id, req.file);
        } finally {
            scrubUploadedFile(req);
        }
    }
}
