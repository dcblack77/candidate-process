import { MAX_CANDIDATE_NAME_LENGTH } from "../candidates/candidate.dto";

/**
 * Nombre del candidato a partir del nombre del archivo (carga masiva, §16).
 *
 * En la subida uno a uno el nombre lo escribe el usuario. En un lote de veinte
 * CVs pedirlo por adelantado es justo la mecánica que la carga masiva quiere
 * evitar, así que el criterio es: el nombre lo pone quien nombró el archivo
 * ("cv_ana-perez.pdf" → "Ana Perez"), el usuario puede sobreescribirlo por
 * archivo en la misma petición y, en cualquier caso, renombrar después con
 * `PATCH /candidates/:id`. Es una propuesta, no una verdad: por eso la regla
 * es deliberadamente simple y predecible en vez de "lista".
 *
 * Regla, en orden:
 * 1. Se quita la extensión y cualquier ruta.
 * 2. `_`, `-`, `.`, `+` y espacios se convierten en un solo espacio.
 * 3. Se eliminan las palabras de relleno habituales en nombres de CV (cv,
 *    currículum, curriculum vitae, resume, hoja de vida…), los tokens
 *    numéricos sueltos (años, versiones) y los "(1)" que añade el navegador
 *    al descargar duplicados.
 * 4. Si el resultado está todo en minúsculas o todo en mayúsculas se pone en
 *    Título; si ya viene con mayúsculas y minúsculas mezcladas se respeta.
 * 5. Se recorta a MAX_CANDIDATE_NAME_LENGTH y, si no queda nada, se usa
 *    "Candidato N" con la posición del archivo en el lote.
 *
 * NUNCA mira dentro del CV: el texto extraído no sale del request y el nombre
 * de la persona no es algo que un modelo de 2B deba adivinar.
 */

/** Palabras que no son nombre: se comparan sin acentos y en minúsculas. */
const NOISE_WORDS = new Set([
    "cv",
    "curriculum",
    "curriculo",
    "vitae",
    "resume",
    "hoja",
    "vida",
    "candidato",
    "candidata",
    "perfil",
    "final",
]);

/**
 * Frases de relleno que hay que quitar ENTERAS antes de mirar palabra a
 * palabra: "de" solo no se toca (Ana de la Torre), pero "hoja de vida" sí.
 */
const NOISE_PHRASES = ["hoja de vida", "curriculum vitae"];

function stripDiacritics(value: string): string {
    return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function toTitleCase(value: string): string {
    return value
        .split(" ")
        .map((word) =>
            word.length === 0
                ? word
                : word[0].toLocaleUpperCase("es-ES") +
                  word.slice(1).toLocaleLowerCase("es-ES"),
        )
        .join(" ");
}

/** Nombre propuesto para el archivo `filename` en la posición `index` (0-based). */
export function candidateNameFromFilename(
    filename: string,
    index: number,
): string {
    const fallback = `Candidato ${index + 1}`;
    if (typeof filename !== "string") {
        return fallback;
    }

    // 1. Sin ruta ni extensión.
    const base = filename.split(/[\\/]/).pop() ?? "";
    const withoutExtension = base.replace(/\.[^.]*$/, "");

    // 2. Separadores → espacio.
    let text = withoutExtension.replace(/[_\-.+\s]+/g, " ").trim();

    // 3. Relleno: frases enteras, luego palabras y números sueltos.
    let comparable = stripDiacritics(text).toLowerCase();
    for (const phrase of NOISE_PHRASES) {
        const at = comparable.indexOf(phrase);
        if (at !== -1) {
            text = (text.slice(0, at) + text.slice(at + phrase.length)).trim();
            comparable = stripDiacritics(text).toLowerCase();
        }
    }
    const words = text.split(" ").filter((word) => {
        if (word.length === 0) {
            return false;
        }
        const plain = stripDiacritics(word).toLowerCase();
        if (NOISE_WORDS.has(plain)) {
            return false;
        }
        // Números sueltos (2026, 2), versiones (v2) y duplicados "(1)".
        return !/^(v?\d+|\(\d+\))$/.test(plain);
    });
    text = words.join(" ");

    // 4. Título solo si el archivo no traía mayúsculas/minúsculas mezcladas.
    if (text === text.toLowerCase() || text === text.toUpperCase()) {
        text = toTitleCase(text.toLowerCase());
    }

    // 5. Tope de longitud y respaldo.
    text = text.slice(0, MAX_CANDIDATE_NAME_LENGTH).trim();
    return text.length > 0 ? text : fallback;
}

/**
 * Evita nombres repetidos dentro del mismo lote añadiendo " (2)", " (3)"…
 * Dos archivos "cv.pdf" y "CV.PDF" no deben acabar como dos "Candidato" que
 * nadie distingue en la lista. Fuera del lote no se comprueba nada: el
 * sistema admite homónimos igual que la subida uno a uno.
 */
export function dedupeNames(names: string[]): string[] {
    const seen = new Map<string, number>();
    return names.map((name) => {
        const key = name.toLocaleLowerCase("es-ES");
        const times = seen.get(key) ?? 0;
        seen.set(key, times + 1);
        if (times === 0) {
            return name;
        }
        const suffix = ` (${times + 1})`;
        return (
            name.slice(0, MAX_CANDIDATE_NAME_LENGTH - suffix.length) + suffix
        );
    });
}
