import { EvidenceItem } from "../ai/schemas/common";
import {
    DetectRisksResult,
    RiskCategory,
    RiskSeverity,
} from "../ai/schemas/detect-risks";
import { Criterion } from "../ai/schemas/common";
import { parseJsonColumn } from "../scoring/scoring.dto";
import { RiskAnalysisRow } from "./risk.repository";
import { RiskVerificationStats } from "./risk-verifier";

/**
 * DTOs del dominio Risks (BLUEPRINT §13 "Riesgos y lagunas").
 * Espejo en apps/web/src/api/types.ts.
 */

/** Riesgo: algo que el resumen del CV dice y preocupa para el rol. */
export interface RiskItemDTO {
    category: RiskCategory;
    criterion: Criterion;
    severity: RiskSeverity;
    /** Qué preocupa y por qué. */
    concern: string;
    /**
     * En qué se apoya. `type: "explicit"` solo si el backend lo encontró en
     * el resumen del CV o en el contexto del rol; si no, `inferred`.
     */
    evidence: EvidenceItem;
    /** Qué preguntar o validar en la entrevista para despejarlo. */
    interviewCheck: string;
}

/** Laguna: algo que el resumen del CV NO permite saber. */
export interface GapItemDTO {
    criterion: Criterion;
    /** Qué no se sabe. */
    missing: string;
    /** Por qué importa para este rol. */
    whyItMatters: string;
    /** Qué preguntar en la entrevista para saberlo. */
    interviewCheck: string;
}

export interface RiskAnalysisDTO {
    risks: RiskItemDTO[];
    gaps: GapItemDTO[];
    /** Confianza declarada por el modelo, 0-1. */
    confidence: number;
    /** Contadores del verificador de evidencia (cuánto se rebajó a inferido). */
    stats: RiskVerificationStats;
    createdAt: string;
    updatedAt: string;
}

/** Respuesta de POST /candidates/:id/risks. */
export interface DetectRisksResponseDTO {
    candidateId: string;
    analysis: RiskAnalysisDTO;
    regenerationsUsed: number;
    regenerationsLimit: number;
}

/**
 * Respuesta de GET /candidates/:id/risks. `analysis` es null si todavía no
 * se ha detectado nada para el candidato (200, no 404: el recurso es "los
 * riesgos del candidato", que existen aunque estén vacíos, y así la UI
 * recibe los contadores de regeneración sin una segunda llamada).
 */
export interface GetRisksResponseDTO {
    candidateId: string;
    analysis: RiskAnalysisDTO | null;
    regenerationsUsed: number;
    regenerationsLimit: number;
}

/** Salida (ya verificada) del modelo → listas en la forma del DTO. */
export function toRiskItems(result: DetectRisksResult): {
    risks: RiskItemDTO[];
    gaps: GapItemDTO[];
} {
    return {
        risks: result.risks.map((risk) => ({
            category: risk.category,
            criterion: risk.criterion,
            severity: risk.severity,
            concern: risk.concern,
            evidence: risk.evidence,
            interviewCheck: risk.interview_check,
        })),
        gaps: result.gaps.map((gap) => ({
            criterion: gap.criterion,
            missing: gap.missing,
            whyItMatters: gap.why_it_matters,
            interviewCheck: gap.interview_check,
        })),
    };
}

/** Columna JSON de lista; si no parsea o no es lista devuelve []. */
function parseListColumn<T>(value: string): T[] {
    const parsed = parseJsonColumn(value);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
}

const EMPTY_STATS: RiskVerificationStats = {
    risks: 0,
    gaps: 0,
    explicit: 0,
    inferred: 0,
    downgradedToInferred: 0,
};

export function toRiskAnalysisDTO(row: RiskAnalysisRow): RiskAnalysisDTO {
    const stats = parseJsonColumn(row.stats);
    return {
        risks: parseListColumn<RiskItemDTO>(row.risks),
        gaps: parseListColumn<GapItemDTO>(row.gaps),
        confidence: row.confidence,
        stats:
            typeof stats === "object" && stats !== null
                ? { ...EMPTY_STATS, ...(stats as Partial<RiskVerificationStats>) }
                : EMPTY_STATS,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}
