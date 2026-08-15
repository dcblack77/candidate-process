import { EvidenceItem } from "../ai/schemas/common";
import { DetectRisksResult, RiskItem } from "../ai/schemas/detect-risks";
import { tokenize } from "../interview/lexical-match";

/**
 * Verificación de la evidencia de los riesgos (BLUEPRINT §13).
 *
 * Módulo PURO, sin modelo. Es la capa que impide que un riesgo "explícito"
 * llegue al evaluador sin que el resumen del CV lo sostenga. La regla del
 * proyecto es que el análisis separa evidencia explícita de inferencia y no
 * inventa experiencia; un modelo de 2B, sin embargo, etiqueta `explicit`
 * cosas que ha deducido o directamente ha inventado. Ese error no se
 * corrige en el prompt: se corrige aquí, en código, igual que hace
 * interview/quote-verifier.ts con las citas de la transcripción.
 *
 * Qué hace:
 *
 * - Un riesgo cuya evidencia dice `explicit` se comprueba contra el texto
 *   fuente (resumen del CV + contexto del rol). Si sus términos significativos
 *   no están ahí, la evidencia se REBAJA a `inferred`. No se borra el riesgo:
 *   quien decide si vale la pena preguntarlo es el evaluador, y ver que es
 *   una deducción ya lo pone en su sitio.
 * - Un riesgo `inferred` no se toca: por definición describe una deducción o
 *   una ausencia y no tiene por qué casar palabra por palabra.
 * - Las lagunas (`gaps`) no llevan evidencia: hablan de lo que el resumen NO
 *   dice y no hay nada que verificar contra él.
 * - Todo texto se recorta de espacios sobrantes.
 *
 * Los contadores de `stats` viajan en la respuesta y se persisten para que
 * quede visible cuántas veces el modelo afirmó algo que el resumen no decía.
 */

/**
 * Fracción mínima de términos de la evidencia que tienen que aparecer en la
 * fuente para aceptar `explicit`. Por debajo, se rebaja a `inferred`.
 *
 * 0,6 y no 1: el modelo parafrasea ("tres años" por "3 años", "banca" por
 * "sector bancario") y exigir literalidad rebajaría casi todo. Con la
 * comparación por raíz de abajo, 0,6 deja pasar la paráfrasis honesta y
 * rebaja lo que no está en el resumen.
 */
export const EXPLICIT_MATCH_THRESHOLD = 0.6;

/**
 * Longitud de la raíz con la que se comparan los términos. "trabajado" y
 * "trabajo", "bancario" y "banca" comparten los cinco primeros caracteres;
 * es un stemming de andar por casa, suficiente para tolerar morfología sin
 * dar por iguales palabras distintas.
 */
const STEM_LENGTH = 5;

export interface RiskVerificationStats {
    /** Riesgos devueltos por el modelo. */
    risks: number;
    /** Lagunas devueltas por el modelo. */
    gaps: number;
    /** Riesgos con evidencia `explicit` tras la verificación. */
    explicit: number;
    /** Riesgos con evidencia `inferred` tras la verificación. */
    inferred: number;
    /** Riesgos que el modelo marcó `explicit` y no se sostenían: rebajados. */
    downgradedToInferred: number;
}

export interface VerifiedRisks {
    result: DetectRisksResult;
    stats: RiskVerificationStats;
}

function stem(token: string): string {
    return token.slice(0, STEM_LENGTH);
}

/**
 * Fracción de términos significativos de `text` cuya raíz aparece en
 * `sourceStems`. Sin términos significativos (evidencia vacía o solo
 * palabras vacías) devuelve 0: una evidencia así no sostiene nada.
 */
export function groundingRatio(text: string, sourceStems: Set<string>): number {
    const terms = new Set(tokenize(text).map(stem));
    if (terms.size === 0) {
        return 0;
    }
    let found = 0;
    for (const term of terms) {
        if (sourceStems.has(term)) {
            found += 1;
        }
    }
    return found / terms.size;
}

/** Índice de raíces de la fuente contra la que se verifica la evidencia. */
export function buildSourceIndex(...sources: string[]): Set<string> {
    return new Set(tokenize(sources.join(" ")).map(stem));
}

function verifyEvidence(
    evidence: EvidenceItem,
    sourceStems: Set<string>,
): { evidence: EvidenceItem; downgraded: boolean } {
    const text = evidence.text.trim();
    if (evidence.type === "inferred") {
        return { evidence: { text, type: "inferred" }, downgraded: false };
    }
    const grounded =
        groundingRatio(text, sourceStems) >= EXPLICIT_MATCH_THRESHOLD;
    return grounded
        ? { evidence: { text, type: "explicit" }, downgraded: false }
        : { evidence: { text, type: "inferred" }, downgraded: true };
}

/**
 * Verifica la salida del modelo contra sus fuentes y devuelve la versión
 * corregida junto con los contadores.
 *
 * @param result  Salida ya validada por el schema de detect-risks.
 * @param sources Textos que el modelo tuvo delante: el resumen del CV y el
 *                contexto del rol. Lo que no esté aquí no puede ser explícito.
 */
export function verifyRisks(
    result: DetectRisksResult,
    sources: string[],
): VerifiedRisks {
    const sourceStems = buildSourceIndex(...sources);
    let downgraded = 0;

    const risks: RiskItem[] = result.risks.map((risk) => {
        const verified = verifyEvidence(risk.evidence, sourceStems);
        if (verified.downgraded) {
            downgraded += 1;
        }
        return {
            ...risk,
            concern: risk.concern.trim(),
            interview_check: risk.interview_check.trim(),
            evidence: verified.evidence,
        };
    });

    const gaps = result.gaps.map((gap) => ({
        ...gap,
        missing: gap.missing.trim(),
        why_it_matters: gap.why_it_matters.trim(),
        interview_check: gap.interview_check.trim(),
    }));

    const explicit = risks.filter(
        (risk) => risk.evidence.type === "explicit",
    ).length;

    return {
        result: { risks, gaps, confidence: result.confidence },
        stats: {
            risks: risks.length,
            gaps: gaps.length,
            explicit,
            inferred: risks.length - explicit,
            downgradedToInferred: downgraded,
        },
    };
}
