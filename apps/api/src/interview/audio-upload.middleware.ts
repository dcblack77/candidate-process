import { NextFunction, Request, Response } from "express";
import multer from "multer";
import { AppError } from "../shared/errors";
import { MAX_INTERVIEW_AUDIO_MB } from "../shared/limits";
import { Speaker } from "./transcript";

/**
 * Subida del audio de la entrevista (BLUEPRINT §17, §24).
 *
 * Mismo contrato que `cv/upload.middleware.ts`, y por el mismo motivo:
 *
 * - `memoryStorage` OBLIGATORIO. El audio de una entrevista es el dato más
 *   sensible que ha manejado este sistema; PROHIBIDO `diskStorage`.
 * - Límite de tamaño en multer, traducido a FILE_TOO_LARGE (413).
 * - Errores genéricos: nunca el nombre del archivo ni nada de su contenido.
 *
 * La diferencia con el CV: aquí el trabajo SOBREVIVE al request (el análisis
 * tarda minutos y el HTTP responde 202 enseguida). Por eso hay una
 * transferencia explícita de propiedad del buffer, `takeAudioOwnership`: a
 * partir de esa llamada el dueño es el job y `req` ya no lo tiene.
 */

/** Tipos que acepta el servicio de transcripción. */
const ALLOWED_MIME_PREFIXES = ["audio/", "video/webm"];

const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: MAX_INTERVIEW_AUDIO_MB * 1024 * 1024,
        files: 2,
    },
    fileFilter: (_req, file, callback) => {
        const allowed = ALLOWED_MIME_PREFIXES.some((prefix) =>
            file.mimetype.startsWith(prefix),
        );
        if (!allowed) {
            callback(new AppError("UNSUPPORTED_MEDIA_TYPE"));
            return;
        }
        callback(null, true);
    },
});

const fields = upload.fields([
    { name: "mic", maxCount: 1 },
    { name: "tab", maxCount: 1 },
]);

export function uploadInterviewAudioMiddleware(
    req: Request,
    res: Response,
    next: NextFunction,
): void {
    fields(req, res, (error: unknown) => {
        if (!error) {
            next();
            return;
        }
        if (error instanceof AppError) {
            next(error);
            return;
        }
        if (
            error instanceof multer.MulterError &&
            error.code === "LIMIT_FILE_SIZE"
        ) {
            next(new AppError("FILE_TOO_LARGE"));
            return;
        }
        next(new AppError("INVALID_INPUT", "La subida del audio no es válida."));
    });
}

/** Una pista lista para transcribir. */
export interface AudioTrack {
    audio: Buffer;
    speaker: Speaker;
    /** Solo para logs: "mic" o "tab". Nunca identifica a nadie. */
    label: string;
}

type MulterFiles = Record<string, Express.Multer.File[]> | undefined;

/**
 * Toma posesión de los buffers subidos y los BORRA de `req` en el mismo acto.
 *
 * A partir de aquí hay exactamente un dueño —el job—, y el `scrub` del
 * `finally` del controller no puede vaciar por debajo un audio que se está
 * transcribiendo. El job los pone a cero en cuanto whisper responde.
 *
 * `candidateSource` dice cuál de las dos pistas es la del candidato: por
 * defecto la de la pestaña, que es donde suena quien está al otro lado de la
 * videollamada.
 */
export function takeAudioOwnership(
    req: Request,
    candidateSource: "mic" | "tab",
): AudioTrack[] {
    const files = req.files as MulterFiles;
    const tracks: AudioTrack[] = [];

    for (const label of ["mic", "tab"] as const) {
        const file = files?.[label]?.[0];
        if (!file) {
            continue;
        }
        tracks.push({
            audio: file.buffer,
            speaker: label === candidateSource ? "candidato" : "sala",
            label,
        });
    }

    // La propiedad se transfiere: `req` deja de referenciar los buffers.
    delete (req as { files?: unknown }).files;
    return tracks;
}

/**
 * Red de seguridad (§17): vacía cualquier buffer que siga colgando de `req`.
 * No-op si `takeAudioOwnership` ya se los llevó. Se llama en un `finally`.
 */
export function scrubUploadedAudio(req: Request): void {
    const files = req.files as MulterFiles;
    if (!files) {
        return;
    }
    for (const list of Object.values(files)) {
        for (const file of list) {
            file.buffer = Buffer.alloc(0);
        }
    }
    delete (req as { files?: unknown }).files;
}
