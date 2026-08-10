import { LlmClient, estimateTokens, truncateToBudget } from "../ai/llm-client";
import { NEUTRAL_ROLE_CONTEXT } from "../ai/role-context";
import {
    ASSESS_COVERAGE_JSON_SCHEMA,
    AssessCoverageResult,
    assessCoverageZodSchema,
} from "../ai/schemas/assess-coverage";
import {
    buildTranscriptTopicsJsonSchema,
    buildTranscriptTopicsZodSchema,
    questionRef,
    refToIndex,
    TranscriptTopicsResult,
} from "../ai/schemas/map-transcript-topics";
import { SttClient } from "../ai/stt-client";
import { InterviewQuestionRow } from "../questions/question.repository";
import { parseJsonColumn } from "../scoring/scoring.dto";
import { MAX_EXCERPT_CHARS, MAX_TRANSCRIPT_CHARS } from "../shared/limits";
import { AppError } from "../shared/errors";
import { chunkTranscript, TranscriptChunk, totalChars } from "./chunking";
import { ProposalInput } from "./proposal.repository";
import { buildQuestionQuery, rankByRelevance } from "./lexical-match";
import { verifyAssessment } from "./quote-verifier";
import {
    formatTimestamp,
    mergeTracks,
    renderDialogue,
    Speaker,
    TranscriptSegment,
} from "./transcript";

/**
 * Orquestación del análisis de una entrevista (BLUEPRINT §24).
 *
 * Función suelta y no clase inyectable a propósito: recibe sus dependencias
 * por parámetro, así que se prueba entera sin contenedor DI ni HTTP.
 *
 * Encadena: transcribir las pistas → fusionar y limpiar → trocear → enrutar
 * cada fragmento contra el índice de preguntas → evaluar cada pregunta contra
 * sus fragmentos → verificar las citas.
 *
 * Solo el PRIMER paso toca el audio: de `mergeTracks` en adelante todo opera
 * sobre `TranscriptSegment[]`. Por eso un reanálisis puede entrar por
 * `source.kind === "transcript"` y recorrer exactamente el mismo camino sin
 * volver a pasar por whisper.
 *
 * PRIVACIDAD (§17, revisado el 2026-08-10): el buffer de audio en RAM se pone
 * a cero en cuanto whisper responde. El audio y la transcripción SÍ se
 * conservan ahora en disco (`recording-store.ts`), pero esta función no los
 * escribe: los entrega por `onTranscribed` y decide el usecase.
 */

/** Enunciado truncado en el índice de preguntas de la etapa 1. */
const INDEX_QUESTION_CHARS = 140;

/** Fragmentos como mucho por pregunta en la etapa 2. */
const MAX_EXCERPTS_PER_QUESTION = 3;

export interface AnalysisPhaseProgress {
    phase: "transcribing" | "routing" | "assessing" | "done";
    done: number;
    total: number;
}

/**
 * De dónde sale la transcripción que se va a analizar.
 *
 * `transcript` es lo que hace reanudable un análisis fallido (§24,
 * 2026-08-10): si el job murió después de transcribir, el reintento entra por
 * aquí y se ahorra los ~4,5 minutos de whisper por pista. El resto del
 * pipeline es idéntico —a partir de `mergeTracks` nunca se tocó el audio—,
 * así que reanalizar da exactamente el mismo recorrido que un análisis nuevo.
 */
export type AnalysisSource =
    | {
          kind: "audio";
          /** Pistas de audio. Al menos una. El buffer se destruye al transcribir. */
          tracks: Array<{ audio: Buffer; speaker: Speaker; label: string }>;
      }
    | {
          kind: "transcript";
          segments: TranscriptSegment[];
          durationSec: number;
      };

export interface RunAnalysisInput {
    source: AnalysisSource;
    questions: InterviewQuestionRow[];
    roleTitle: string;
    roleContext: string | null;
}

export interface RunAnalysisDeps {
    stt: SttClient;
    llm: LlmClient;
    onProgress?: (progress: AnalysisPhaseProgress) => void;
    signal?: AbortSignal;
    /**
     * Se llama en cuanto la transcripción está lista y ANTES de la primera
     * llamada al modelo. Ese orden es el punto entero: si el análisis muere
     * durante el enrutado o la evaluación, la transcripción ya está a salvo.
     * Solo se invoca cuando se ha transcrito de verdad, no al reanalizar.
     */
    onTranscribed?: (transcript: {
        segments: TranscriptSegment[];
        durationSec: number;
    }) => void;
}

export interface RunAnalysisResult {
    proposals: ProposalInput[];
    stats: {
        durationSec: number;
        segments: number;
        chunks: number;
        questionsAssessed: number;
        llmCalls: number;
        demoted: number;
        /**
         * Fragmentos cuyo enrutado falló (el modelo devolvió algo que no
         * encaja con el schema). No tumba el análisis —entra el respaldo
         * léxico— pero tiene que verse: si es alto, las preguntas se están
         * evaluando con fragmentos elegidos por palabras, no por sentido.
         */
        routingFailures: number;
    };
}

export async function runInterviewAnalysis(
    input: RunAnalysisInput,
    deps: RunAnalysisDeps,
): Promise<RunAnalysisResult> {
    const { stt, llm, onProgress, signal, onTranscribed } = deps;

    // ── Transcripción ──────────────────────────────────────────────────────
    const { segments, durationSec } =
        input.source.kind === "transcript"
            ? // Reanálisis: la transcripción ya está en disco de un intento
              // anterior. No se vuelve a llamar a whisper ni se toca el audio.
              input.source
            : await transcribeTracks(input.source.tracks, {
                  stt,
                  signal,
                  onProgress,
                  onTranscribed,
              });

    if (totalChars(segments) > MAX_TRANSCRIPT_CHARS) {
        throw new AppError(
            "LIMIT_EXCEEDED",
            "La transcripción de esta entrevista es demasiado larga para analizarla.",
        );
    }

    const chunks = chunkTranscript(segments);
    const pending = input.questions;
    const total = chunks.length + pending.length;
    let done = 0;
    let llmCalls = 0;
    let routingFailures = 0;

    // ── Etapa 1: enrutado ──────────────────────────────────────────────────
    const refs = pending.map((_, i) => questionRef(i));
    const questionsIndex = pending
        .map(
            (question, i) =>
                `${questionRef(i)}. ${question.question.slice(0, INDEX_QUESTION_CHARS)}`,
        )
        .join("\n");

    /** Índices de fragmento asignados a cada pregunta, con su relevancia. */
    const routed = new Map<number, Array<{ chunk: number; central: boolean }>>();

    for (const chunk of chunks) {
        throwIfAborted(signal);
        onProgress?.({ phase: "routing", done, total });
        try {
            const result = await llm.complete<TranscriptTopicsResult>({
                promptName: "map-transcript-topics",
                variables: {
                    fragment: chunk.text,
                    fragment_range: `${formatTimestamp(chunk.startSec)}–${formatTimestamp(chunk.endSec)}`,
                    questions_index: questionsIndex,
                    role_title: input.roleTitle,
                },
                schema: buildTranscriptTopicsJsonSchema(refs),
                zodSchema: buildTranscriptTopicsZodSchema(refs),
            });
            llmCalls += 1;
            for (const match of result.matches) {
                const index = refToIndex(match.question_ref);
                if (index < 0 || index >= pending.length) {
                    continue;
                }
                const list = routed.get(index) ?? [];
                list.push({
                    chunk: chunk.index,
                    central: match.relevance === "central",
                });
                routed.set(index, list);
            }
        } catch (error) {
            // Un fragmento que el modelo no supo clasificar no tumba el
            // análisis: el respaldo léxico cubre a las preguntas afectadas.
            if (error instanceof AppError && error.code === "LLM_UNAVAILABLE") {
                llmCalls += 1;
                routingFailures += 1;
            } else {
                throw error;
            }
        }
        done += 1;
    }

    // ── Etapa 2: evaluación por pregunta ───────────────────────────────────
    const proposals: ProposalInput[] = [];
    let demoted = 0;

    for (const [index, question] of pending.entries()) {
        throwIfAborted(signal);
        onProgress?.({ phase: "assessing", done, total });

        const excerptChunks = selectExcerpts(
            chunks,
            routed.get(index) ?? [],
            question,
        );
        const excerptSegments = excerptChunks.flatMap((chunk) => chunk.segments);
        const excerpts = renderExcerpts(excerptChunks);

        const variables = {
            question: question.question,
            criterion: question.criterion,
            dimension: question.dimension,
            ideal_answer: question.ideal_answer ?? "(sin respuesta ideal)",
            positive_signals: bulletList(question.positive_signals),
            warning_signals: bulletList(question.warning_signals),
            scoring_guidance: question.scoring_guidance ?? "(sin guía)",
            role_title: input.roleTitle,
            role_context: input.roleContext ?? NEUTRAL_ROLE_CONTEXT,
            transcript_excerpts: excerpts,
        };

        const raw = await llm.complete<AssessCoverageResult>({
            promptName: "assess-question-coverage",
            variables: withBudgetedExcerpts(variables, excerpts),
            schema: ASSESS_COVERAGE_JSON_SCHEMA,
            zodSchema: assessCoverageZodSchema,
        });
        llmCalls += 1;

        const verified = verifyAssessment(raw, excerptSegments);
        if (verified.demoted) {
            demoted += 1;
        }
        proposals.push({
            questionId: question.id,
            coverage: verified.coverage,
            proposedScore: verified.proposedScore,
            proposedNotes: verified.proposedNotes,
            evidence: verified.evidence,
            confidence: verified.confidence,
        });
        done += 1;
    }

    onProgress?.({ phase: "done", done: total, total });

    return {
        proposals,
        stats: {
            durationSec: Math.round(durationSec),
            segments: segments.length,
            chunks: chunks.length,
            questionsAssessed: proposals.length,
            llmCalls,
            demoted,
            routingFailures,
        },
    };
}

/**
 * Transcribe las pistas y las fusiona en una única transcripción atribuida.
 *
 * `onTranscribed` se dispara aquí, antes de devolver: a partir de ese punto
 * el trabajo caro ya está a salvo en disco y un fallo posterior solo cuesta
 * las llamadas al modelo (§24, 2026-08-10).
 */
async function transcribeTracks(
    tracks: Array<{ audio: Buffer; speaker: Speaker; label: string }>,
    deps: Pick<RunAnalysisDeps, "stt" | "signal" | "onProgress" | "onTranscribed">,
): Promise<{ segments: TranscriptSegment[]; durationSec: number }> {
    const { stt, signal, onProgress, onTranscribed } = deps;
    onProgress?.({ phase: "transcribing", done: 0, total: tracks.length });

    const transcribed = [];
    let durationSec = 0;
    for (const [i, track] of tracks.entries()) {
        const result = await stt.transcribe(track.audio, track.label, signal);
        // El buffer en RAM se pone a cero en cuanto tenemos el texto. El audio
        // sigue existiendo en disco —esa es la decisión del 2026-08-10— pero
        // no hay motivo para mantener además una copia en memoria.
        track.audio.fill(0);
        durationSec = Math.max(durationSec, result.durationSec);
        transcribed.push({ segments: result.segments, speaker: track.speaker });
        onProgress?.({
            phase: "transcribing",
            done: i + 1,
            total: tracks.length,
        });
    }

    const segments = mergeTracks(transcribed);
    onTranscribed?.({ segments, durationSec });
    return { segments, durationSec };
}

/**
 * Elige los fragmentos que se le mandan a una pregunta.
 *
 * Prioridad: los que la etapa 1 marcó como `central`, luego los
 * `tangencial`. Si la etapa 1 no enrutó nada —cosa que pasa: un modelo de 2B
 * se deja fragmentos—, entra el respaldo léxico y se evalúa igualmente con el
 * mejor candidato. Sin ese respaldo, una pregunta se quedaría sin evaluar en
 * silencio y el evaluador no sabría que le falta.
 */
export function selectExcerpts(
    chunks: TranscriptChunk[],
    routedTo: Array<{ chunk: number; central: boolean }>,
    question: Pick<
        InterviewQuestionRow,
        "question" | "ideal_answer" | "positive_signals"
    >,
): TranscriptChunk[] {
    if (chunks.length === 0) {
        return [];
    }

    const query = buildQuestionQuery({
        question: question.question,
        ideal_answer: question.ideal_answer,
        positive_signals: parseSignals(question.positive_signals),
    });

    if (routedTo.length === 0) {
        const ranked = rankByRelevance(
            query,
            chunks.map((chunk) => ({ index: chunk.index, text: chunk.text })),
        );
        const best = ranked[0];
        // Sin ninguna palabra en común no se manda nada: el modelo evaluará
        // sobre vacío y responderá `no_abordado`, que es lo correcto.
        return best && best.score > 0
            ? [chunks[best.index]]
            : [];
    }

    const centralFirst = [...routedTo].sort(
        (a, b) => Number(b.central) - Number(a.central),
    );
    const unique = [...new Set(centralFirst.map((item) => item.chunk))];

    const selected: TranscriptChunk[] = [];
    let chars = 0;
    for (const chunkIndex of unique) {
        const chunk = chunks[chunkIndex];
        if (!chunk) {
            continue;
        }
        if (
            selected.length >= MAX_EXCERPTS_PER_QUESTION ||
            chars + chunk.text.length > MAX_EXCERPT_CHARS
        ) {
            break;
        }
        selected.push(chunk);
        chars += chunk.text.length;
    }

    // Orden cronológico: la conversación se lee mejor en orden.
    return selected.sort((a, b) => a.index - b.index);
}

/** Fragmentos con su rango temporal por delante, como los espera el prompt. */
function renderExcerpts(chunks: TranscriptChunk[]): string {
    if (chunks.length === 0) {
        return "(No hay ningún fragmento de la entrevista relacionado con esta pregunta.)";
    }
    return chunks
        .map(
            (chunk) =>
                `### Fragmento ${formatTimestamp(chunk.startSec)}–${formatTimestamp(chunk.endSec)}\n\n` +
                renderDialogue(chunk.segments),
        )
        .join("\n\n");
}

/**
 * Recorta los fragmentos si el prompt no cabe. `LlmClient` lanza
 * INVALID_INPUT cuando se pasa del presupuesto, y eso a media evaluación
 * tumbaría el análisis entero: más vale mandar menos transcripción.
 */
function withBudgetedExcerpts(
    variables: Record<string, string>,
    excerpts: string,
): Record<string, string> {
    const overhead = estimateTokens(
        Object.entries(variables)
            .filter(([key]) => key !== "transcript_excerpts")
            .map(([, value]) => value)
            .join(" "),
    );
    // 20016 de entrada menos el resto del prompt y un margen para la
    // plantilla; se queda corto a propósito.
    const budget = Math.max(1_000, 18_000 - overhead);
    return {
        ...variables,
        transcript_excerpts: truncateToBudget(excerpts, budget),
    };
}

function bulletList(rawJson: string | null): string {
    const signals = parseSignals(rawJson);
    return signals.length > 0
        ? signals.map((signal) => `- ${signal}`).join("\n")
        : "(sin señales)";
}

function parseSignals(rawJson: string | null): string[] {
    const parsed = parseJsonColumn(rawJson);
    if (!Array.isArray(parsed)) {
        return [];
    }
    return parsed.filter((item): item is string => typeof item === "string");
}

function throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted) {
        throw new AppError(
            "INVALID_INPUT",
            "El análisis de la entrevista se canceló.",
        );
    }
}

export type { TranscriptSegment };
