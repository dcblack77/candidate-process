import {
    CHUNK_MAX_SECONDS,
    CHUNK_OVERLAP_SECONDS,
    CHUNK_TARGET_CHARS,
    MAX_TRANSCRIPT_CHUNKS,
} from "../shared/limits";
import { renderDialogue, TranscriptSegment } from "./transcript";

/**
 * Troceado de la transcripción para la etapa de enrutado (BLUEPRINT §24).
 *
 * Módulo PURO. Dos reglas mandan:
 *
 * 1. **Nunca se parte dentro de un segmento de whisper.** La unidad mínima es
 *    la frase que el transcriptor entregó entera.
 * 2. **Los fragmentos se solapan.** Una respuesta que cae justo en el corte
 *    quedaría partida por la mitad en los dos lados, y el modelo no sabría
 *    juzgarla en ninguno. Con solape aparece completa al menos en uno.
 */

export interface TranscriptChunk {
    index: number;
    startSec: number;
    endSec: number;
    /** Diálogo ya renderizado, listo para el prompt. */
    text: string;
    segments: TranscriptSegment[];
}

export interface ChunkOptions {
    targetChars?: number;
    maxSeconds?: number;
    overlapSeconds?: number;
    maxChunks?: number;
}

/**
 * Trocea la transcripción. Si con los parámetros dados salen más de
 * `maxChunks`, reintenta con fragmentos proporcionalmente más grandes en vez
 * de descartar audio: perder el final de una entrevista sería peor que
 * mandar fragmentos algo más largos.
 */
export function chunkTranscript(
    segments: TranscriptSegment[],
    options: ChunkOptions = {},
): TranscriptChunk[] {
    const maxChunks = options.maxChunks ?? MAX_TRANSCRIPT_CHUNKS;
    let targetChars = options.targetChars ?? CHUNK_TARGET_CHARS;
    let maxSeconds = options.maxSeconds ?? CHUNK_MAX_SECONDS;
    const overlapSeconds = options.overlapSeconds ?? CHUNK_OVERLAP_SECONDS;

    // Cota de seguridad: cada vuelta duplica el tamaño, así que converge muy
    // rápido incluso para entrevistas larguísimas.
    for (let attempt = 0; attempt < 8; attempt++) {
        const chunks = buildChunks(
            segments,
            targetChars,
            maxSeconds,
            overlapSeconds,
        );
        if (chunks.length <= maxChunks) {
            return chunks;
        }
        const factor = Math.ceil(chunks.length / maxChunks);
        targetChars *= factor;
        maxSeconds *= factor;
    }

    return buildChunks(segments, targetChars, maxSeconds, overlapSeconds).slice(
        0,
        maxChunks,
    );
}

function buildChunks(
    segments: TranscriptSegment[],
    targetChars: number,
    maxSeconds: number,
    overlapSeconds: number,
): TranscriptChunk[] {
    if (segments.length === 0) {
        return [];
    }

    const chunks: TranscriptChunk[] = [];
    let current: TranscriptSegment[] = [];
    let chars = 0;

    const flush = (): void => {
        if (current.length === 0) {
            return;
        }
        chunks.push(toChunk(chunks.length, current));
        // El fragmento siguiente arranca reincluyendo la cola de este.
        current = tailWithin(current, overlapSeconds);
        chars = current.reduce((total, s) => total + s.text.length, 0);
    };

    for (const segment of segments) {
        const wouldExceedChars =
            current.length > 0 && chars + segment.text.length > targetChars;
        const wouldExceedSeconds =
            current.length > 0 &&
            segment.endSec - current[0].startSec > maxSeconds;

        if (wouldExceedChars || wouldExceedSeconds) {
            flush();
        }

        current.push(segment);
        chars += segment.text.length;
    }

    if (current.length > 0) {
        chunks.push(toChunk(chunks.length, current));
    }

    // El último flush puede dejar un fragmento que es solo el solape del
    // anterior: información repetida sin nada nuevo. Se descarta.
    return chunks.filter(
        (chunk, index) =>
            index === 0 || !isContainedIn(chunk, chunks[index - 1]),
    );
}

function toChunk(
    index: number,
    segments: TranscriptSegment[],
): TranscriptChunk {
    return {
        index,
        startSec: segments[0].startSec,
        endSec: segments[segments.length - 1].endSec,
        text: renderDialogue(segments),
        segments: [...segments],
    };
}

/** Los últimos segmentos que caben en `overlapSeconds` desde el final. */
function tailWithin(
    segments: TranscriptSegment[],
    overlapSeconds: number,
): TranscriptSegment[] {
    if (overlapSeconds <= 0 || segments.length === 0) {
        return [];
    }
    const endsAt = segments[segments.length - 1].endSec;
    const tail = segments.filter(
        (segment) => endsAt - segment.startSec <= overlapSeconds,
    );
    // Nunca se devuelve el fragmento entero como solape: eso no avanzaría y
    // el bucle no terminaría nunca.
    return tail.length >= segments.length ? tail.slice(1) : tail;
}

/** ¿`chunk` no aporta nada que `previous` no tuviera ya? */
function isContainedIn(
    chunk: TranscriptChunk,
    previous: TranscriptChunk,
): boolean {
    return (
        chunk.startSec >= previous.startSec && chunk.endSec <= previous.endSec
    );
}

/** Total de caracteres de una transcripción, para los límites de §16. */
export function totalChars(segments: TranscriptSegment[]): number {
    return segments.reduce((total, segment) => total + segment.text.length, 0);
}
