/**
 * Ranking léxico de fragmentos frente a una pregunta (BLUEPRINT §24).
 *
 * Módulo PURO, sin modelo. Cubre dos huecos de la etapa de enrutado:
 *
 * 1. Cuando a una pregunta se le enrutaron más fragmentos de los que caben en
 *    el presupuesto, decide cuáles se mandan.
 * 2. Cuando NO se le enrutó ninguno, elige el candidato menos malo para
 *    evaluarla igualmente. Sin esto, un fallo del modelo de 2B en la etapa 1
 *    dejaría preguntas sin evaluar **en silencio**, que es la peor forma de
 *    fallar: el evaluador no sabría que le falta algo.
 *
 * Es TF-IDF muy básico a propósito: no hace falta más para ordenar tres
 * fragmentos, y una dependencia nueva no se justifica.
 */

/**
 * Palabras vacías del español, más las que aparecen en casi cualquier
 * respuesta técnica hablada y no distinguen nada.
 */
const STOPWORDS = new Set([
    "a", "al", "algo", "algun", "alguna", "algunas", "alguno", "algunos",
    "ante", "antes", "aqui", "asi", "aunque", "bien", "cada", "como", "con",
    "contra", "cual", "cuando", "de", "del", "desde", "donde", "dos", "el",
    "ella", "ellas", "ellos", "en", "entre", "era", "eran", "es", "esa",
    "ese", "eso", "esta", "estaba", "estan", "este", "esto", "estos", "fue",
    "fueron", "ha", "habia", "hace", "hacer", "hasta", "hay", "la", "las",
    "le", "les", "lo", "los", "mas", "me", "mi", "mucho", "muy", "no", "nos",
    "o", "otra", "otro", "para", "pero", "poco", "por", "porque", "pues",
    "que", "se", "ser", "si", "sin", "sobre", "solo", "son", "su", "sus",
    "tambien", "te", "tenia", "tener", "tiene", "todo", "todos", "tu", "un",
    "una", "uno", "unos", "y", "ya", "yo",
    // Muletillas y verbos de relleno del habla espontánea.
    "bueno", "entonces", "digamos", "osea", "vale", "claro", "mira",
    "cosa", "cosas", "hacia", "hicimos", "hice", "tema", "temas",
]);

/**
 * Minúsculas, sin acentos ni puntuación: whisper no es fiable con tildes, así
 * que comparar con ellas produciría fallos de emparejamiento constantes.
 *
 * `\u0300-\u036f` es el bloque de diacríticos combinantes que deja `NFD` tras
 * descomponer. Se escribe con escapes y no con los caracteres literales para
 * que el rango sea legible en cualquier editor.
 *
 * Eso incluye la tilde de la eñe, así que "diseño" queda en "diseno". Es
 * deliberado: lo que importa no es preservar la palabra, sino que consulta y
 * documento se plieguen IGUAL — y whisper transcribe eñes de forma poco
 * fiable, con lo que exigir la tilde produciría fallos de emparejamiento.
 */
export function normalizeText(text: string): string {
    return text
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[^a-z0-9\s]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

/** Términos significativos de un texto (sin stopwords ni palabras de 1-2 letras). */
export function tokenize(text: string): string[] {
    return normalizeText(text)
        .split(" ")
        .filter((word) => word.length > 2 && !STOPWORDS.has(word));
}

/** Documento puntuable: cualquier cosa con texto y un identificador. */
export interface ScorableDocument {
    index: number;
    text: string;
}

export interface ScoredDocument extends ScorableDocument {
    score: number;
}

/**
 * Ordena los documentos por relevancia frente a `query`, de mayor a menor.
 *
 * Puntúa cada término una sola vez por documento (presencia, no frecuencia):
 * en habla espontánea repetir una palabra suele ser una muletilla, no señal
 * de que el tema se trate más a fondo. El peso IDF penaliza los términos que
 * salen en todos los fragmentos y premia los específicos.
 *
 * Empates: gana el fragmento con índice menor (el más temprano). Determinista
 * a propósito, para que los tests no dependan del orden de entrada.
 */
export function rankByRelevance(
    query: string,
    documents: ScorableDocument[],
): ScoredDocument[] {
    const terms = new Set(tokenize(query));
    if (terms.size === 0 || documents.length === 0) {
        return documents.map((doc) => ({ ...doc, score: 0 }));
    }

    const tokenized = documents.map((doc) => new Set(tokenize(doc.text)));

    const idf = new Map<string, number>();
    for (const term of terms) {
        const docsWithTerm = tokenized.filter((set) => set.has(term)).length;
        // +1 arriba y abajo: evita dividir por cero y suaviza el extremo.
        idf.set(term, Math.log((documents.length + 1) / (docsWithTerm + 1)) + 1);
    }

    return documents
        .map((doc, position) => {
            let score = 0;
            for (const term of terms) {
                if (tokenized[position].has(term)) {
                    score += idf.get(term) ?? 0;
                }
            }
            return { ...doc, score };
        })
        .sort((a, b) => (b.score !== a.score ? b.score - a.score : a.index - b.index));
}

/**
 * Consulta de una pregunta: enunciado + respuesta ideal + señales positivas.
 * Se incluyen las tres porque el enunciado solo suele ser demasiado corto
 * para discriminar, y la respuesta ideal es justo el vocabulario que se
 * espera oír.
 */
export function buildQuestionQuery(question: {
    question: string;
    ideal_answer?: string | null;
    positive_signals?: string[] | null;
}): string {
    return [
        question.question,
        question.ideal_answer ?? "",
        (question.positive_signals ?? []).join(" "),
    ].join(" ");
}
