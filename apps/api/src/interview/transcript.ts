import { SttSegment } from "../ai/stt-client";

/**
 * Fusión y limpieza de las pistas de una entrevista (BLUEPRINT §24).
 *
 * Módulo PURO: sin DB, sin DI, sin red. Mismo patrón que
 * `scoring/interview-context.ts`.
 *
 * Por qué dos pistas y no una mezclada: whisper no diariza. Si el micrófono
 * y el audio de la videollamada llegan mezclados, nada distingue "el
 * candidato explicó cómo particionó el dominio" de "el entrevistador preguntó
 * cómo lo particionó" — y esa confusión es un falso positivo irrecuperable
 * aguas abajo. Grabando por separado, la atribución de hablante es un dato,
 * no una súplica al prompt.
 */

/** Quién habla en un tramo. */
export type Speaker = "candidato" | "sala";

/** Etiquetas tal y como aparecen en el texto que ve el modelo. */
export const SPEAKER_LABELS: Record<Speaker, string> = {
    candidato: "CANDIDATO",
    sala: "SALA",
};

/** Segmento ya atribuido a un hablante. */
export interface TranscriptSegment {
    startSec: number;
    endSec: number;
    text: string;
    speaker: Speaker;
}

/**
 * Por encima de esto se considera silencio y se descarta. whisper marca así
 * los tramos sin voz, que son justo donde alucina.
 */
const NO_SPEECH_THRESHOLD = 0.6;

/**
 * Frases que whisper inventa sobre silencio o música. No son transcripción
 * de nadie: vienen del corpus de subtítulos con el que se entrenó. Colarlas
 * sería dar por dicho algo que nunca se dijo, así que se filtran antes de
 * que lleguen al modelo.
 */
const HALLUCINATION_PATTERNS: RegExp[] = [
    /subt[ií]tulos?\s+(realizados?|por)/i,
    /subtitul(ado|os)\s+por/i,
    /amara\.org/i,
    /gracias por ver(\s+el)?\s+(v[ií]deo|video)/i,
    /suscr[ií](bete|banse)/i,
    /^\s*[¡!]?\s*(gracias|adi[oó]s)\s*[.!¡]?\s*$/i,
    /^\s*[[(]?\s*(m[uú]sica|aplausos|risas|silencio)\s*[\])]?\s*[.!]?\s*$/i,
    /^\s*(thanks for watching|subscribe)/i,
];

/** ¿Este texto es ruido conocido de whisper en vez de habla real? */
export function isHallucination(text: string): boolean {
    const trimmed = text.trim();
    if (trimmed.length === 0) {
        return true;
    }
    return HALLUCINATION_PATTERNS.some((pattern) => pattern.test(trimmed));
}

/** Una pista transcrita, con a quién pertenece. */
export interface TranscriptTrack {
    segments: SttSegment[];
    speaker: Speaker;
}

/**
 * Fusiona las pistas en una única línea temporal, descartando silencio y
 * alucinaciones. Orden: por instante de inicio; a igualdad, primero el
 * candidato (es lo que importa) y luego por texto, para que el resultado sea
 * determinista y los tests no dependan del orden de llegada.
 */
export function mergeTracks(tracks: TranscriptTrack[]): TranscriptSegment[] {
    const merged: TranscriptSegment[] = [];

    for (const track of tracks) {
        for (const segment of track.segments) {
            if ((segment.noSpeechProb ?? 0) > NO_SPEECH_THRESHOLD) {
                continue;
            }
            const text = segment.text.trim().replace(/\s+/g, " ");
            if (isHallucination(text)) {
                continue;
            }
            merged.push({
                startSec: segment.start,
                endSec: segment.end,
                text,
                speaker: track.speaker,
            });
        }
    }

    return merged.sort((a, b) => {
        if (a.startSec !== b.startSec) {
            return a.startSec - b.startSec;
        }
        if (a.speaker !== b.speaker) {
            return a.speaker === "candidato" ? -1 : 1;
        }
        return a.text.localeCompare(b.text);
    });
}

/** `754` → `"12:34"`. Para que el evaluador localice la cita en la grabación. */
export function formatTimestamp(seconds: number): string {
    const total = Math.max(0, Math.floor(seconds));
    const minutes = Math.floor(total / 60);
    const rest = total % 60;
    return `${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
}

/**
 * Renderiza los segmentos como diálogo etiquetado, que es lo que lee el
 * modelo:
 *
 * ```text
 * [12:31] CANDIDATO: pues tuvimos que partir el dominio por…
 * [12:48] SALA: ¿y cómo comprobaste que aguantaba?
 * ```
 */
export function renderDialogue(segments: TranscriptSegment[]): string {
    return segments
        .map(
            (segment) =>
                `[${formatTimestamp(segment.startSec)}] ` +
                `${SPEAKER_LABELS[segment.speaker]}: ${segment.text}`,
        )
        .join("\n");
}

/**
 * Solo lo que dijo el candidato, en texto plano. Es contra esto —y no contra
 * el diálogo completo— contra lo que se verifican las citas: una cita que en
 * realidad salió de la boca del entrevistador no demuestra nada del
 * candidato (ver `quote-verifier.ts`).
 */
export function candidateText(segments: TranscriptSegment[]): string {
    return segments
        .filter((segment) => segment.speaker === "candidato")
        .map((segment) => segment.text)
        .join("\n");
}
