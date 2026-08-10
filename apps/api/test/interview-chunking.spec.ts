import { describe, expect, it } from "vitest";
import { chunkTranscript, totalChars } from "../src/interview/chunking";
import { TranscriptSegment } from "../src/interview/transcript";

/**
 * Troceado de la transcripción (§24). Dos invariantes que el modelo de 2B
 * necesita para no equivocarse: que un segmento nunca se parta por la mitad,
 * y que los fragmentos se solapen para que una respuesta a caballo del corte
 * aparezca entera en alguno.
 */

/** Genera `count` segmentos de `seconds` y `chars` caracteres cada uno. */
function segments(
    count: number,
    { seconds = 10, chars = 100 } = {},
): TranscriptSegment[] {
    return Array.from({ length: count }, (_, i) => ({
        startSec: i * seconds,
        endSec: (i + 1) * seconds,
        text: `s${i} `.padEnd(chars, "x"),
        speaker: i % 3 === 0 ? ("sala" as const) : ("candidato" as const),
    }));
}

describe("chunkTranscript", () => {
    it("sin segmentos devuelve lista vacía", () => {
        expect(chunkTranscript([])).toEqual([]);
    });

    it("una transcripción corta cabe en un solo fragmento", () => {
        const chunks = chunkTranscript(segments(3));
        expect(chunks).toHaveLength(1);
        expect(chunks[0].index).toBe(0);
        expect(chunks[0].segments).toHaveLength(3);
    });

    it("corta por caracteres cuando se supera el objetivo", () => {
        const chunks = chunkTranscript(segments(10, { chars: 100 }), {
            targetChars: 250,
            maxSeconds: 10_000,
            overlapSeconds: 0,
        });
        expect(chunks.length).toBeGreaterThan(1);
        for (const chunk of chunks) {
            // Se permite rebasar por el último segmento: no se parte a mitad.
            expect(totalChars(chunk.segments)).toBeLessThanOrEqual(350);
        }
    });

    it("corta por duración aunque quepan de sobra los caracteres", () => {
        const chunks = chunkTranscript(segments(10, { seconds: 60, chars: 20 }), {
            targetChars: 100_000,
            maxSeconds: 120,
            overlapSeconds: 0,
        });
        expect(chunks.length).toBeGreaterThan(1);
        for (const chunk of chunks) {
            expect(chunk.endSec - chunk.startSec).toBeLessThanOrEqual(180);
        }
    });

    it("nunca parte un segmento: todos aparecen enteros", () => {
        const input = segments(12, { chars: 120 });
        const chunks = chunkTranscript(input, {
            targetChars: 300,
            overlapSeconds: 0,
        });
        const seen = chunks.flatMap((chunk) =>
            chunk.segments.map((segment) => segment.text),
        );
        for (const segment of input) {
            expect(seen).toContain(segment.text);
        }
    });

    it("solapa: el arranque de un fragmento repite la cola del anterior", () => {
        const chunks = chunkTranscript(segments(12, { seconds: 10, chars: 120 }), {
            targetChars: 300,
            maxSeconds: 10_000,
            overlapSeconds: 20,
        });
        expect(chunks.length).toBeGreaterThan(1);
        for (let i = 1; i < chunks.length; i++) {
            // El fragmento i empieza antes de que acabe el i-1.
            expect(chunks[i].startSec).toBeLessThan(chunks[i - 1].endSec);
        }
    });

    it("sin solape los fragmentos no se pisan", () => {
        const chunks = chunkTranscript(segments(12, { chars: 120 }), {
            targetChars: 300,
            overlapSeconds: 0,
        });
        for (let i = 1; i < chunks.length; i++) {
            expect(chunks[i].startSec).toBeGreaterThanOrEqual(
                chunks[i - 1].endSec,
            );
        }
    });

    it("respeta el tope de fragmentos agrandándolos, sin tirar audio", () => {
        const input = segments(200, { seconds: 10, chars: 200 });
        const chunks = chunkTranscript(input, {
            targetChars: 200,
            maxSeconds: 20,
            overlapSeconds: 0,
            maxChunks: 6,
        });
        expect(chunks.length).toBeLessThanOrEqual(6);
        // El último fragmento llega hasta el final de la entrevista: no se
        // descartó la cola para cumplir el tope.
        expect(chunks[chunks.length - 1].endSec).toBe(
            input[input.length - 1].endSec,
        );
    });

    it("un único segmento gigantesco sale en su propio fragmento", () => {
        const huge: TranscriptSegment[] = [
            {
                startSec: 0,
                endSec: 600,
                text: "x".repeat(20_000),
                speaker: "candidato",
            },
        ];
        const chunks = chunkTranscript(huge, { targetChars: 500 });
        expect(chunks).toHaveLength(1);
        expect(chunks[0].segments).toHaveLength(1);
    });

    it("los índices son consecutivos desde 0", () => {
        const chunks = chunkTranscript(segments(20, { chars: 150 }), {
            targetChars: 300,
        });
        expect(chunks.map((c) => c.index)).toEqual(
            chunks.map((_, i) => i),
        );
    });

    it("el texto del fragmento ya viene renderizado como diálogo", () => {
        const chunks = chunkTranscript(segments(2));
        expect(chunks[0].text).toMatch(/\[00:00\] (SALA|CANDIDATO): /);
    });
});
