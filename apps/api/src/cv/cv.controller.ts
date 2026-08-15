import {
    controller,
    Delete,
    Get,
    Http,
    param,
    Post,
    request,
} from "@expressots/adapter-express";
import { inject } from "@expressots/core";
import { Request } from "express";
import {
    canCreateCandidate,
    canUploadCV,
    requirePermission,
} from "../security/permissions";
import { BulkImportCvsUseCase } from "./bulk-import.usecase";
import { CvBulkImportResponseDTO, CvExtractResponseDTO } from "./cv.dto";
import { ExtractCvUseCase } from "./extract-cv.usecase";
import {
    scrubUploadedFile,
    scrubUploadedFiles,
    uploadCvBatchMiddleware,
    uploadCvMiddleware,
} from "./upload.middleware";

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
        @inject(BulkImportCvsUseCase)
        private readonly bulkImport: BulkImportCvsUseCase,
    ) {}

    /**
     * Carga masiva (§16, 2026-08-15): varios CVs en el campo `files` (+ campo
     * opcional `names`, JSON). Crea los candidatos y responde 202 con el job;
     * el resumen con el modelo sigue en segundo plano. Exige los dos permisos
     * porque hace las dos cosas: crear candidatos y subir CVs.
     */
    @Post("/cv/bulk", uploadCvBatchMiddleware)
    @Http(202)
    async bulk(@request() req: Request): Promise<CvBulkImportResponseDTO> {
        try {
            requirePermission(canCreateCandidate, req.currentUser);
            requirePermission(canUploadCV, req.currentUser);
            const files = Array.isArray(req.files) ? req.files : undefined;
            const names = (req.body as Record<string, unknown> | undefined)
                ?.names;
            return await this.bulkImport.execute(files, names);
        } finally {
            scrubUploadedFiles(req);
        }
    }

    @Get("/cv/bulk/:jobId")
    bulkStatus(
        @request() req: Request,
        @param("jobId") jobId: string,
    ): CvBulkImportResponseDTO {
        requirePermission(canUploadCV, req.currentUser);
        return this.bulkImport.status(jobId);
    }

    @Delete("/cv/bulk/:jobId")
    @Http(200)
    bulkCancel(
        @request() req: Request,
        @param("jobId") jobId: string,
    ): CvBulkImportResponseDTO {
        requirePermission(canUploadCV, req.currentUser);
        return this.bulkImport.cancel(jobId);
    }

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
