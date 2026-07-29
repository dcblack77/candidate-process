import path from "node:path";
import { AnalysisStatus } from "../candidates/candidate.repository";
import { AppError } from "../shared/errors";
import { CvKind } from "./extractors";

/**
 * DTOs y validación de entrada del dominio CV (BLUEPRINT §10, §16).
 * Los mensajes de error NUNCA incluyen el nombre del archivo, el mimetype
 * recibido ni contenido: solo el motivo genérico.
 */

/** Extensiones permitidas → formato (§16: PDF, DOCX, TXT). */
const KIND_BY_EXTENSION: Record<string, CvKind> = {
    ".pdf": "pdf",
    ".docx": "docx",
    ".txt": "txt",
};

/** Mimetypes permitidos → formato. Ambas listas deben coincidir en formato. */
const KIND_BY_MIMETYPE: Record<string, CvKind> = {
    "application/pdf": "pdf",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
        "docx",
    "text/plain": "txt",
};

/** Lo único que el dominio CV necesita del archivo subido por multer. */
export interface UploadedCvFile {
    originalname: string;
    mimetype: string;
    buffer: Buffer;
}

/** Respuesta de POST /candidates/:id/cv/extract. */
export interface CvExtractResponseDTO {
    candidateId: string;
    analysisStatus: AnalysisStatus;
    /** Caracteres extraídos del CV (antes de truncar). */
    extractedChars: number;
    /** true si el texto se recortó (50k chars o presupuesto de tokens). */
    truncated: boolean;
    /** Resumen estructurado devuelto por el modelo y persistido. */
    cvSummary: unknown;
    /** El archivo original nunca se persiste (§04/§17): siempre true. */
    fileDeleted: true;
}

/**
 * Valida el archivo subido: debe existir y su extensión Y su mimetype deben
 * estar en la whitelist Y designar el mismo formato. Si falta el archivo →
 * INVALID_INPUT (400); si el formato no está permitido → UNSUPPORTED_MEDIA_TYPE (415).
 */
export function validateUploadedCv(file: UploadedCvFile | undefined): CvKind {
    if (!file || !Buffer.isBuffer(file.buffer)) {
        throw new AppError(
            "INVALID_INPUT",
            'Falta el archivo (campo multipart "file").',
        );
    }

    const extension = path.extname(file.originalname ?? "").toLowerCase();
    // El mimetype puede llegar con parámetros ("text/plain; charset=utf-8").
    const mimetype = (file.mimetype ?? "").split(";")[0].trim().toLowerCase();

    const kindByExtension = KIND_BY_EXTENSION[extension];
    const kindByMimetype = KIND_BY_MIMETYPE[mimetype];
    if (
        !kindByExtension ||
        !kindByMimetype ||
        kindByExtension !== kindByMimetype
    ) {
        throw new AppError("UNSUPPORTED_MEDIA_TYPE");
    }
    return kindByExtension;
}
