import { PDFParse } from "pdf-parse";
import { AppError } from "../../shared/errors";

/**
 * Extractor de texto de PDF con `pdf-parse` v2 (reescritura mantenida sobre
 * pdf.js; funciona en Node 22 y CommonJS, a diferencia de la v1 abandonada).
 *
 * Privacidad (§17): ante un PDF corrupto se lanza INVALID_INPUT con mensaje
 * genérico — sin nombre de archivo, sin contenido, sin el error del parser.
 */
export async function extractPdf(buffer: Buffer): Promise<string> {
    // Copia defensiva: pdf.js transfiere/detacha el ArrayBuffer que recibe.
    const parser = new PDFParse({ data: new Uint8Array(buffer) });
    try {
        const result = await parser.getText();
        return result.text;
    } catch {
        throw new AppError(
            "INVALID_INPUT",
            "No se pudo extraer texto del PDF.",
        );
    } finally {
        await parser.destroy().catch(() => undefined);
    }
}
