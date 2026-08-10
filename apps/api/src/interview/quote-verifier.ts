import { AssessCoverageResult } from "../ai/schemas/assess-coverage";
import { MAX_QUOTES_PER_PROPOSAL, MAX_QUOTE_CHARS } from "../shared/limits";
import {
    CoverageLevel,
    isCovered,
    ProposalQuoteDTO,
} from "./interview.dto";
import { normalizeText } from "./lexical-match";
import { TranscriptSegment } from "./transcript";

/**
 * Verificación de las citas y degradación de la cobertura (BLUEPRINT §24).
 *
 * Módulo PURO, y la pieza que hace que la funcionalidad sea fiable. El
 * prompt puede pedirle al modelo que no invente, pero un modelo de 2B lo hace
 * igual: dice "abordado_demostrado" y adorna una cita que nadie pronunció.
 *
 * Aquí eso se corta con hechos, no con instrucciones:
 *
 * 1. Una cita solo vale si aparece LITERALMENTE en lo que dijo el CANDIDATO.
 *    Lo que preguntó la sala no demuestra nada de él.
 * 2. Si tras verificar no queda ninguna cita, una cobertura `abordado_*` se
 *    degrada a `mencionado`: sin evidencia no hay afirmación.
 * 3. Hay un suelo de longitud por nivel. Nadie demuestra dominio de un tema
 *    en ocho palabras.
 * 4. La nota propuesta solo sobrevive si el nivel final la justifica.
 */

/**
 * Fracción de la cita que basta para darla por buena. El modelo suele cortar
 * o rematar la última palabra; exigir coincidencia exacta descartaría citas
 * legítimas y produciría falsos negativos en cadena.
 */
const PREFIX_TOLERANCE = 0.8;

/**
 * Los fragmentos llegan al modelo como `[12:31] CANDIDATO: texto`, y el
 * modelo copia la línea ENTERA cuando se le pide una cita literal —incluido
 * el prefijo—. Verificado contra `gemma-4-E2B` el 2026-08-07: sin quitarlo,
 * NINGUNA cita casaba y todas las propuestas se degradaban a `mencionado`.
 *
 * Se limpia aquí y no se le pide al modelo que no lo ponga: obedecer eso es
 * justo el tipo de instrucción que un modelo pequeño ignora, y el coste de
 * equivocarse era anular la funcionalidad entera.
 */
const QUOTE_PREFIX_RE = /^\s*(?:\[\s*\d{1,3}:\d{2}\s*\]\s*)?(?:(?:CANDIDATO|SALA)\s*:\s*)?/i;

/** Quita marcas de tiempo y etiquetas de hablante de una cita copiada. */
export function stripQuotePrefix(quote: string): string {
    // En bucle: el modelo a veces encadena varias líneas en una sola cita.
    let cleaned = quote.replace(QUOTE_PREFIX_RE, "");
    cleaned = cleaned
        .replace(/\[\s*\d{1,3}:\d{2}\s*\]/g, " ")
        .replace(/\b(?:CANDIDATO|SALA)\s*:/gi, " ");
    return cleaned.replace(/\s+/g, " ").trim();
}

/** Caracteres mínimos de cita verificada para sostener cada nivel. */
const MIN_EVIDENCE_CHARS: Record<CoverageLevel, number> = {
    no_abordado: 0,
    mencionado: 0,
    abordado_parcial: 60,
    abordado_demostrado: 180,
};

/** Resultado ya verificado, listo para persistir como propuesta. */
export interface VerifiedAssessment {
    coverage: CoverageLevel;
    proposedScore: number | null;
    proposedNotes: string | null;
    evidence: ProposalQuoteDTO[];
    confidence: number;
    /** true si el código bajó el nivel que propuso el modelo. */
    demoted: boolean;
}

/** Segmento del candidato con su texto ya normalizado, para buscar rápido. */
interface SearchableSegment {
    segment: TranscriptSegment;
    normalized: string;
}

/**
 * Prepara el índice de búsqueda: SOLO líneas del candidato. Es la diferencia
 * entre "lo demostró" y "se lo preguntaron".
 */
export function buildCandidateIndex(
    segments: TranscriptSegment[],
): SearchableSegment[] {
    return segments
        .filter((segment) => segment.speaker === "candidato")
        .map((segment) => ({
            segment,
            normalized: normalizeText(segment.text),
        }));
}

/**
 * Localiza una cita en lo que dijo el candidato. Devuelve el tramo temporal
 * donde aparece, o `null` si no la dijo.
 *
 * Se busca segmento a segmento y también sobre el texto concatenado, porque
 * una cita puede cruzar la frontera entre dos segmentos de whisper.
 */
export function locateQuote(
    quote: string,
    index: SearchableSegment[],
): ProposalQuoteDTO | null {
    const cleaned = stripQuotePrefix(quote);
    const normalized = normalizeText(cleaned);
    if (normalized.length === 0 || index.length === 0) {
        return null;
    }

    const needles = [normalized];
    const prefixLength = Math.floor(normalized.length * PREFIX_TOLERANCE);
    if (prefixLength >= 20 && prefixLength < normalized.length) {
        needles.push(normalized.slice(0, prefixLength));
    }

    for (const needle of needles) {
        // Dentro de un solo segmento: el caso normal.
        const direct = index.find((entry) => entry.normalized.includes(needle));
        if (direct) {
            return {
                quote: cleaned.slice(0, MAX_QUOTE_CHARS),
                startSec: direct.segment.startSec,
                endSec: direct.segment.endSec,
            };
        }

        // A caballo de varios segmentos: se busca sobre el texto unido y se
        // recupera el rango de los segmentos que cubre.
        const spanning = locateAcrossSegments(needle, index);
        if (spanning) {
            return {
                quote: cleaned.slice(0, MAX_QUOTE_CHARS),
                startSec: spanning.startSec,
                endSec: spanning.endSec,
            };
        }
    }

    return null;
}

function locateAcrossSegments(
    needle: string,
    index: SearchableSegment[],
): { startSec: number; endSec: number } | null {
    // Offsets de cada segmento dentro del texto concatenado, para traducir
    // una posición de carácter de vuelta a marcas de tiempo.
    const offsets: Array<{ start: number; end: number; entry: SearchableSegment }> =
        [];
    let joined = "";
    for (const entry of index) {
        const start = joined.length;
        joined += (joined.length > 0 ? " " : "") + entry.normalized;
        offsets.push({ start, end: joined.length, entry });
    }

    const at = joined.indexOf(needle);
    if (at === -1) {
        return null;
    }
    const until = at + needle.length;
    const covering = offsets.filter(
        (offset) => offset.end > at && offset.start < until,
    );
    if (covering.length === 0) {
        return null;
    }
    return {
        startSec: covering[0].entry.segment.startSec,
        endSec: covering[covering.length - 1].entry.segment.endSec,
    };
}

/**
 * Aplica las cuatro capas al resultado crudo del modelo.
 *
 * `segments` son los fragmentos que se le enviaron: verificar contra la
 * transcripción entera permitiría que una cita de otro momento de la
 * entrevista colara como prueba de esta pregunta.
 */
export function verifyAssessment(
    raw: AssessCoverageResult,
    segments: TranscriptSegment[],
): VerifiedAssessment {
    const index = buildCandidateIndex(segments);

    const evidence: ProposalQuoteDTO[] = [];
    for (const item of raw.evidence) {
        const located = locateQuote(item.quote, index);
        if (located) {
            evidence.push(located);
        }
        if (evidence.length >= MAX_QUOTES_PER_PROPOSAL) {
            break;
        }
    }

    const evidenceChars = evidence.reduce(
        (total, item) => total + item.quote.trim().length,
        0,
    );

    let coverage = raw.coverage;

    // Capa 2: afirmar cobertura sin poder citar es exactamente lo que hay que
    // impedir. Sin evidencia, como mucho "mencionado".
    if (isCovered(coverage) && evidence.length === 0) {
        coverage = "mencionado";
    }

    // Capa 3: suelo de longitud. Se baja un nivel cada vez hasta que la
    // evidencia sostenga la afirmación.
    while (isCovered(coverage) && evidenceChars < MIN_EVIDENCE_CHARS[coverage]) {
        coverage =
            coverage === "abordado_demostrado"
                ? "abordado_parcial"
                : "mencionado";
    }

    const notes = raw.proposed_notes.trim();

    // `no_abordado` con citas es ruido: el modelo las adjunta igual, y en
    // pantalla parecerían pruebas de algo que él mismo dice que no pasó.
    const finalEvidence = coverage === "no_abordado" ? [] : evidence;

    return {
        coverage,
        // Capa 4: la nota solo sobrevive si el nivel final la justifica.
        proposedScore: isCovered(coverage) ? raw.proposed_score : null,
        proposedNotes: notes.length > 0 ? notes : null,
        evidence: finalEvidence,
        confidence: raw.confidence,
        demoted: coverage !== raw.coverage,
    };
}
