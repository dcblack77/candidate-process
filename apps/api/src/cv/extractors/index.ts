import { extractDocx } from "./docx";
import { extractPdf } from "./pdf";
import { extractTxt } from "./txt";

/**
 * Extractores de texto de CV (BLUEPRINT §16: formatos permitidos).
 * El buffer vive SOLO en memoria: ningún extractor escribe a disco ni
 * loguea contenido. Los errores de parseo son INVALID_INPUT genéricos.
 */

/** Formatos de CV admitidos (§16). */
export const CV_KINDS = ["pdf", "docx", "txt"] as const;

export type CvKind = (typeof CV_KINDS)[number];

/** Extrae el texto plano del buffer según el formato detectado. */
export function extractText(buffer: Buffer, kind: CvKind): Promise<string> {
    switch (kind) {
        case "pdf":
            return extractPdf(buffer);
        case "docx":
            return extractDocx(buffer);
        case "txt":
            return Promise.resolve(extractTxt(buffer));
    }
}
