/**
 * Extractor de texto plano (TXT).
 *
 * Decodifica UTF-8 en modo estricto; si el archivo no es UTF-8 válido
 * (CVs antiguos exportados en ISO-8859-1/Windows-1252) cae a latin1, que
 * nunca falla. El buffer solo se lee: jamás se escribe a disco ni se loguea.
 */
export function extractTxt(buffer: Buffer): string {
    try {
        return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    } catch {
        return buffer.toString("latin1");
    }
}
