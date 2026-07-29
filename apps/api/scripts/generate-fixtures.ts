import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import JSZip from "jszip";

/**
 * Generador de fixtures de CV para los tests (plan §F4).
 *
 * Todo el contenido es SINTÉTICO (candidata inventada). Los tres archivos se
 * construyen por código, sin binarios opacos en el repo:
 *
 * - cv-sample.txt  → texto plano UTF-8.
 * - cv-sample.pdf  → PDF 1.4 mínimo construido a mano (objetos + xref con
 *   offsets calculados; texto sin comprimir con operadores Tj). Legible por
 *   pdf-parse sin necesitar pdf-lib.
 * - cv-sample.docx → DOCX mínimo (un DOCX es un zip: [Content_Types].xml,
 *   _rels/.rels y word/document.xml) generado con jszip (devDependency).
 *
 * Regeneración: `pnpm --filter api exec tsx scripts/generate-fixtures.ts`
 * (los specs también llaman a ensureFixtures() en beforeAll, así que basta
 * con borrar test/fixtures/ para regenerarlos).
 *
 * El TXT incluye una "trampa" de datos personales (SENTINEL_PERSONAL_DATA):
 * los tests verifican que esa frase jamás llega a la DB ni a los logs.
 */

/** Directorio de fixtures de los tests. */
export const FIXTURES_DIR = path.resolve(__dirname, "..", "test", "fixtures");

/**
 * Trampa de datos personales irrelevantes (§04): presente en el CV de
 * entrada, NO debe sobrevivir en DB ni en logs (solo viaja al modelo local).
 */
export const SENTINEL_PERSONAL_DATA =
    "Calle Sentinela Privada 742, Villarrobledo (SENTINEL-DATO-PERSONAL-742)";

/** Marcadores únicos por formato: prueban que la extracción de texto funcionó. */
export const TXT_MARKER = "MARCADOR-TXT-ORINOCO";
export const PDF_MARKER = "MARCADOR-PDF-ORINOCO";
export const DOCX_MARKER = "MARCADOR-DOCX-ORINOCO";

/** Líneas del CV sintético compartidas por los tres formatos. */
function cvLines(marker: string): string[] {
    return [
        "Ana Ejemplo Ficticia - Ingeniera de Software Backend",
        `Direccion: ${SENTINEL_PERSONAL_DATA}`,
        "Edad: 34 anios. Estado civil: casada. Nacionalidad: ficticia.",
        "",
        "Experiencia:",
        "- 2021-2024 Orinoco Ficticia SL: APIs serverless en AWS Lambda con TypeScript.",
        "- 2018-2021 Datos Inventados SA: migracion de monolito Java a Node.js.",
        "- Operacion de sistemas en produccion: guardias, debugging y postmortems.",
        "",
        "Formacion: Grado en Ingenieria Informatica (universidad inventada).",
        `Referencia interna del fixture: ${marker}`,
    ];
}

/** CV sintético en texto plano. */
export function buildCvTxt(): Buffer {
    return Buffer.from(cvLines(TXT_MARKER).join("\n") + "\n", "utf8");
}

/**
 * PDF 1.4 mínimo y válido: catálogo → páginas → página con fuente Helvetica
 * y un content stream sin comprimir que pinta cada línea con Tj/T*.
 * Los offsets de la tabla xref se calculan sobre el propio buffer.
 */
export function buildCvPdf(): Buffer {
    const escapeText = (value: string): string =>
        value
            .replace(/\\/g, "\\\\")
            .replace(/\(/g, "\\(")
            .replace(/\)/g, "\\)");

    const content =
        "BT /F1 11 Tf 50 780 Td 14 TL\n" +
        cvLines(PDF_MARKER)
            .map((line) => `(${escapeText(line)}) Tj T*`)
            .join("\n") +
        "\nET";

    const objects = [
        "<< /Type /Catalog /Pages 2 0 R >>",
        "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] " +
            "/Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
        `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
    ];

    let pdf = "%PDF-1.4\n";
    const offsets: number[] = [];
    objects.forEach((body, index) => {
        offsets.push(Buffer.byteLength(pdf));
        pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
    });

    const xrefStart = Buffer.byteLength(pdf);
    pdf +=
        `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` +
        offsets
            .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
            .join("") +
        `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;

    // latin1: el PDF mínimo es ASCII puro; nada de multibyte en el stream.
    return Buffer.from(pdf, "latin1");
}

/** DOCX mínimo (zip OOXML) con un párrafo por línea del CV. */
export async function buildCvDocx(): Promise<Buffer> {
    const escapeXml = (value: string): string =>
        value
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;");

    const paragraphs = cvLines(DOCX_MARKER)
        .map(
            (line) =>
                `<w:p><w:r><w:t xml:space="preserve">${escapeXml(line)}</w:t></w:r></w:p>`,
        )
        .join("");

    const zip = new JSZip();
    zip.file(
        "[Content_Types].xml",
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
            '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
            '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
            '<Default Extension="xml" ContentType="application/xml"/>' +
            '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
            "</Types>",
    );
    zip.file(
        "_rels/.rels",
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
            '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
            "</Relationships>",
    );
    zip.file(
        "word/document.xml",
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
            '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
            `<w:body>${paragraphs}</w:body></w:document>`,
    );
    return zip.generateAsync({ type: "nodebuffer" });
}

/** Escribe (o reescribe) los tres fixtures en test/fixtures/. */
export async function ensureFixtures(
    dir: string = FIXTURES_DIR,
): Promise<void> {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "cv-sample.txt"), buildCvTxt());
    writeFileSync(path.join(dir, "cv-sample.pdf"), buildCvPdf());
    writeFileSync(path.join(dir, "cv-sample.docx"), await buildCvDocx());
}

/* Ejecutable directamente: pnpm --filter api exec tsx scripts/generate-fixtures.ts */
if (require.main === module) {
    void ensureFixtures().then(() => {
        console.info(`[fixtures] regenerados en ${FIXTURES_DIR}`);
    });
}
