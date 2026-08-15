import { inject, injectable } from "@expressots/core";
import { Database, DB } from "../db/database";
import { newId } from "../shared/ids";

/**
 * Repositorio de candidate_risk_analysis (migración 007, BLUEPRINT §13).
 * Una fila por candidato con la ÚLTIMA detección de riesgos y lagunas; las
 * listas se guardan como JSON ya en la forma del DTO (camelCase).
 */

export interface RiskAnalysisRow {
    id: string;
    candidate_id: string;
    confidence: number;
    /** JSON de RiskItemDTO[]. */
    risks: string;
    /** JSON de GapItemDTO[]. */
    gaps: string;
    /** JSON de RiskVerificationStats. */
    stats: string;
    created_at: string;
    updated_at: string;
}

export interface UpsertRiskAnalysisInput {
    confidence: number;
    risksJson: string;
    gapsJson: string;
    statsJson: string;
}

@injectable()
export class RiskRepository {
    constructor(@inject(DB) private readonly db: Database) {}

    findByCandidate(candidateId: string): RiskAnalysisRow | undefined {
        return this.db
            .prepare(
                "SELECT * FROM candidate_risk_analysis WHERE candidate_id = ?",
            )
            .get(candidateId) as RiskAnalysisRow | undefined;
    }

    /**
     * Inserta o reemplaza la detección del candidato. `created_at` se
     * conserva en la regeneración; `updated_at` se refresca en UTC.
     */
    upsert(candidateId: string, input: UpsertRiskAnalysisInput): RiskAnalysisRow {
        this.db
            .prepare(
                `INSERT INTO candidate_risk_analysis
                     (id, candidate_id, confidence, risks, gaps, stats)
                 VALUES (?, ?, ?, ?, ?, ?)
                 ON CONFLICT (candidate_id) DO UPDATE SET
                     confidence = excluded.confidence,
                     risks = excluded.risks,
                     gaps = excluded.gaps,
                     stats = excluded.stats,
                     updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
            )
            .run(
                newId(),
                candidateId,
                input.confidence,
                input.risksJson,
                input.gapsJson,
                input.statsJson,
            );
        return this.findByCandidate(candidateId) as RiskAnalysisRow;
    }
}
