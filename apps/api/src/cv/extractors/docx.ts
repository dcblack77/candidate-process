import mammoth from "mammoth";
import { AppError } from "../../shared/errors";

/**
 * Extractor de texto de DOCX con `mammoth` (extractRawText: solo el texto,
 * sin estilos). Trabaja sobre el buffer en memoria: nada toca disco.
 *
 * Privacidad (§17): ante un DOCX corrupto se lanza INVALID_INPUT con mensaje
 * genérico — sin nombre de archivo, sin contenido, sin el error del parser.
 */
export async function extractDocx(buffer: Buffer): Promise<string> {
    try {
        const result = await mammoth.extractRawText({ buffer });
        return result.value;
    } catch {
        throw new AppError(
            "INVALID_INPUT",
            "No se pudo extraer texto del DOCX.",
        );
    }
}
