import {
    mkdirSync,
    readdirSync,
    readFileSync,
    renameSync,
    rmSync,
    statSync,
    writeFileSync,
} from "node:fs";
import path from "node:path";
import { z } from "zod";
import { AppError } from "../shared/errors";
import { Speaker, TranscriptSegment } from "./transcript";

/**
 * Almacén en disco de las grabaciones de entrevista (BLUEPRINT §24, decisión
 * del 2026-08-10 que deroga el "el audio no se persiste" de §17).
 *
 * Por qué existe: el job de análisis vive en memoria y si muere a medias se
 * perdía todo, incluido el audio —que el navegador tampoco conservaba—, y
 * había que repetir la entrevista o renunciar a analizarla. Persistir las
 * pistas convierte un fallo irrecuperable en un reintento, y persistir la
 * transcripción hace que ese reintento no repita los ~4,5 minutos de whisper
 * por pista.
 *
 * Estructura, un directorio por grabación:
 *
 *     data/interviews/<recordingId>/mic.webm
 *     data/interviews/<recordingId>/tab.webm
 *     data/interviews/<recordingId>/transcript.json
 *
 * Decisiones que importan:
 *
 * - **Archivos, no BLOBs en SQLite.** Una entrevista son decenas de MB por
 *   pista; SQLite los cargaría enteros en RAM en cada lectura y la base
 *   crecería a cientos de MB. Un directorio se borra de una vez.
 * - **Escritura atómica** (`.tmp` + `rename`). El fallo que motivó todo esto
 *   es un proceso que muere a mitad del trabajo: un `transcript.json` a medio
 *   escribir sería indistinguible de uno válido y envenenaría el reanálisis.
 * - **Permisos restrictivos** (0700 el directorio, 0600 los archivos). No
 *   sustituye al cifrado en reposo —que sigue siendo deuda (§17)— pero evita
 *   que otro usuario de la máquina lea grabaciones de personas reales.
 * - **Validación al leer.** El disco es entrada no confiable: un archivo
 *   truncado o de otra versión se rechaza en vez de propagarse.
 *
 * El nombre del archivo NUNCA lleva nada del candidato: es `mic`/`tab` y el
 * directorio es un UUID.
 */

/** Versión del formato de `transcript.json`. Sube si cambia el shape. */
const TRANSCRIPT_FORMAT_VERSION = 1;

const TRANSCRIPT_FILE = "transcript.json";

/** Permisos del directorio de una grabación: solo el dueño. */
const DIR_MODE = 0o700;

/** Permisos de cada archivo: solo el dueño, y sin ejecución. */
const FILE_MODE = 0o600;

/** Una pista tal y como se guarda en disco. */
export interface StoredTrack {
    /** "mic" o "tab". Nunca identifica a nadie. */
    label: string;
    speaker: Speaker;
    /** Nombre del archivo dentro del directorio de la grabación. */
    file: string;
    bytes: number;
}

/** Pista con su audio en memoria, tal y como la maneja el runner. */
export interface RecordingTrack {
    audio: Buffer;
    speaker: Speaker;
    label: string;
}

/** Transcripción persistida de una grabación. */
export interface StoredTranscript {
    durationSec: number;
    segments: TranscriptSegment[];
}

const storedTranscriptSchema = z.object({
    version: z.literal(TRANSCRIPT_FORMAT_VERSION),
    durationSec: z.number().nonnegative(),
    segments: z.array(
        z.object({
            startSec: z.number(),
            endSec: z.number(),
            text: z.string(),
            speaker: z.enum(["candidato", "sala"]),
        }),
    ),
});

/** Directorio de una grabación. `id` ya viene validado como UUID. */
function recordingDir(root: string, id: string): string {
    return path.join(root, id);
}

/**
 * Escribe un archivo de forma atómica: primero `.tmp`, luego `rename`. En el
 * mismo sistema de archivos `rename` es atómico, así que un lector nunca ve
 * contenido a medias — que es justo el fallo del que venimos.
 */
function writeAtomic(target: string, data: Buffer | string): void {
    const temporary = `${target}.tmp`;
    writeFileSync(temporary, data, { mode: FILE_MODE });
    renameSync(temporary, target);
}

/**
 * Guarda las pistas de una grabación y devuelve su descriptor.
 *
 * Se llama ANTES de lanzar el job: a partir de aquí el audio sobrevive a que
 * el proceso muera, que es el objetivo entero de este módulo.
 */
export function saveTracks(
    root: string,
    id: string,
    tracks: RecordingTrack[],
): StoredTrack[] {
    const dir = recordingDir(root, id);
    mkdirSync(dir, { recursive: true, mode: DIR_MODE });

    return tracks.map((track) => {
        const file = `${track.label}.webm`;
        writeAtomic(path.join(dir, file), track.audio);
        return {
            label: track.label,
            speaker: track.speaker,
            file,
            bytes: track.audio.length,
        };
    });
}

/**
 * Relee las pistas del disco para reanalizar. Solo hace falta cuando NO hay
 * transcripción guardada: con ella el audio ya no se toca.
 *
 * Lanza NOT_FOUND si los archivos ya no están (alguien borró el directorio a
 * mano): mejor un 404 explícito que un análisis sobre audio vacío.
 */
export function readTracks(
    root: string,
    id: string,
    tracks: StoredTrack[],
): RecordingTrack[] {
    const dir = recordingDir(root, id);
    return tracks.map((track) => {
        try {
            return {
                audio: readFileSync(path.join(dir, track.file)),
                speaker: track.speaker,
                label: track.label,
            };
        } catch {
            throw new AppError(
                "NOT_FOUND",
                "El audio de esta grabación ya no está en disco.",
            );
        }
    });
}

/**
 * Guarda la transcripción en cuanto whisper responde, no al final del job:
 * si el análisis muere durante las llamadas al modelo, el reintento arranca
 * ya transcrito.
 */
export function saveTranscript(
    root: string,
    id: string,
    transcript: StoredTranscript,
): void {
    const dir = recordingDir(root, id);
    mkdirSync(dir, { recursive: true, mode: DIR_MODE });
    writeAtomic(
        path.join(dir, TRANSCRIPT_FILE),
        JSON.stringify({
            version: TRANSCRIPT_FORMAT_VERSION,
            durationSec: transcript.durationSec,
            segments: transcript.segments,
        }),
    );
}

/**
 * Lee la transcripción guardada. Devuelve `null` si no existe o si el archivo
 * no es válido: en ambos casos la salida es la misma —volver a transcribir
 * desde el audio—, así que un archivo corrupto degrada en vez de romper.
 */
export function readTranscript(
    root: string,
    id: string,
): StoredTranscript | null {
    let raw: string;
    try {
        raw = readFileSync(
            path.join(recordingDir(root, id), TRANSCRIPT_FILE),
            "utf8",
        );
    } catch {
        return null;
    }

    try {
        const parsed = storedTranscriptSchema.parse(JSON.parse(raw));
        return {
            durationSec: parsed.durationSec,
            segments: parsed.segments,
        };
    } catch {
        // Sin detalles en el log: el contenido es transcripción de una
        // persona real y §17 lo mantiene fuera de los registros.
        console.warn(
            `[recording] transcripción ilegible, se retranscribirá recording=${id}`,
        );
        return null;
    }
}

/**
 * Borra el directorio entero de una grabación: audio y transcripción de una
 * vez. Idempotente — borrar algo que ya no está no es un error, porque se
 * llama también al purgar un proceso cuyos archivos quizá ya se limpiaron.
 */
export function removeRecording(root: string, id: string): void {
    rmSync(recordingDir(root, id), { recursive: true, force: true });
}

/**
 * Nombre de directorio que este almacén puede haber creado: un UUID v4 y nada
 * más. El barrido de huérfanas SOLO toca lo que encaje aquí, para que apuntar
 * `RECORDINGS_DIR` a un directorio compartido no acabe en un borrado ajeno.
 */
const RECORDING_DIR_REGEX =
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Borra las grabaciones que ya no tienen fila en la base de datos y devuelve
 * cuáles eran.
 *
 * Hace falta porque los archivos no participan del `ON DELETE CASCADE`: basta
 * con que alguien borre filas por una vía que no sea el usecase —restaurar un
 * backup viejo de la base, un DELETE a mano— para que queden directorios con
 * audio de personas reales que la aplicación ya no sabe que existen y que
 * nadie podría borrar desde la pantalla. Se ejecuta al arrancar.
 */
export function pruneOrphanRecordings(
    root: string,
    knownIds: Set<string>,
): string[] {
    let entries: string[];
    try {
        entries = readdirSync(root);
    } catch {
        // Todavía no existe: no hay nada que barrer.
        return [];
    }

    const removed: string[] = [];
    for (const entry of entries) {
        if (!RECORDING_DIR_REGEX.test(entry) || knownIds.has(entry)) {
            continue;
        }
        removeRecording(root, entry);
        removed.push(entry);
    }
    return removed;
}

/** Bytes que ocupa una grabación en disco, o 0 si ya no está. */
export function recordingBytes(
    root: string,
    id: string,
    tracks: StoredTrack[],
): number {
    const dir = recordingDir(root, id);
    let total = 0;
    for (const file of [...tracks.map((t) => t.file), TRANSCRIPT_FILE]) {
        try {
            total += statSync(path.join(dir, file)).size;
        } catch {
            // Falta un archivo: no suma. La grabación sigue siendo usable si
            // lo que falta es la transcripción.
        }
    }
    return total;
}
