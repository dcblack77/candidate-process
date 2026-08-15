import { NextFunction, Request, Response } from "express";
import multer from "multer";
import { AppError } from "../shared/errors";
import { MAX_BULK_CV_FILES, MAX_CV_MB } from "../shared/limits";

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

/**
 * Carga masiva (§16, 2026-08-15): mismo storage en memoria y mismo tope por
 * archivo, hasta MAX_BULK_CV_FILES archivos en el campo `files`. Un archivo
 * de más de MAX_CV_MB tumba la subida ENTERA (multer aborta el multipart y no
 * hay forma de seguir con los demás): es un 413 antes de crear nada, se quita
 * ese archivo y se vuelve a subir. Más archivos de la cuenta es LIMIT_EXCEEDED
 * también antes de crear nada.
 */
const batch = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: MAX_CV_MB * 1024 * 1024,
        files: MAX_BULK_CV_FILES,
    },
    // Aquí el nombre del archivo SÍ importa (de él sale el nombre del
    // candidato) y los navegadores lo mandan en UTF-8: sin esto multer lo
    // decodifica como latin1 y "Gómez" llega como "GÃ³mez".
    defParamCharset: "utf8",
}).array("files", MAX_BULK_CV_FILES);

/** Traduce los errores de multer a AppError sin filtrar nada del archivo. */
function translateMulterError(error: unknown, subject: string): AppError {
    if (error instanceof multer.MulterError) {
        if (error.code === "LIMIT_FILE_SIZE") {
            return new AppError("FILE_TOO_LARGE");
        }
        if (
            error.code === "LIMIT_FILE_COUNT" ||
            error.code === "LIMIT_UNEXPECTED_FILE"
        ) {
            return new AppError(
                "LIMIT_EXCEEDED",
                `Demasiados archivos en un solo lote (máximo ${MAX_BULK_CV_FILES}).`,
            );
        }
    }
    return new AppError("INVALID_INPUT", `La subida ${subject} no es válida.`);
}

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

export function uploadCvBatchMiddleware(
    req: Request,
    res: Response,
    next: NextFunction,
): void {
    batch(req, res, (error: unknown) => {
        if (!error) {
            next();
            return;
        }
        next(translateMulterError(error, "de los archivos"));
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

/** Igual que `scrubUploadedFile` para el lote de la carga masiva. */
export function scrubUploadedFiles(req: Request): void {
    if (Array.isArray(req.files)) {
        for (const file of req.files) {
            file.buffer = Buffer.alloc(0);
        }
    }
    delete req.files;
}
