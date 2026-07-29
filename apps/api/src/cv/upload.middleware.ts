import { NextFunction, Request, Response } from "express";
import multer from "multer";
import { AppError } from "../shared/errors";
import { MAX_CV_MB } from "../shared/limits";

/**
 * Middleware de subida del CV (BLUEPRINT §16, §17).
 *
 * - `memoryStorage` OBLIGATORIO: el archivo vive solo en RAM durante el
 *   request. PROHIBIDO diskStorage — el CV original jamás toca disco.
 * - Límite de tamaño en multer (MAX_CV_MB): superarlo corta la subida y se
 *   traduce a FILE_TOO_LARGE (413) sin retener el contenido.
 * - Cualquier otro error de multer/multipart se traduce a INVALID_INPUT
 *   genérico: nunca se propagan mensajes con nombre de archivo o contenido.
 */
const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: MAX_CV_MB * 1024 * 1024,
        files: 1,
    },
});

const single = upload.single("file");

export function uploadCvMiddleware(
    req: Request,
    res: Response,
    next: NextFunction,
): void {
    single(req, res, (error: unknown) => {
        if (!error) {
            next();
            return;
        }
        if (
            error instanceof multer.MulterError &&
            error.code === "LIMIT_FILE_SIZE"
        ) {
            next(new AppError("FILE_TOO_LARGE"));
            return;
        }
        next(
            new AppError(
                "INVALID_INPUT",
                "La subida del archivo no es válida.",
            ),
        );
    });
}

/**
 * GARANTÍA DE NO PERSISTENCIA (§04/§17): anula las referencias al buffer del
 * archivo subido para que no sobreviva al request (se llama en un finally).
 */
export function scrubUploadedFile(req: Request): void {
    if (req.file) {
        req.file.buffer = Buffer.alloc(0);
        delete req.file;
    }
}
