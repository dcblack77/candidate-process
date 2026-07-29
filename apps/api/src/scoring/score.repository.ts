import { inject, injectable } from "@expressots/core";
import { Database, DB } from "../db/database";
import { newId } from "../shared/ids";
import { CriterionScores } from "./weights";

/**
 * Repositorio de candidate_score (BLUEPRINT §12): una fila por candidato
 * (UNIQUE candidate_id), upsert al analizar y actualización parcial al
 * editar. `updated_at` se refresca en UTC en cada escritura.
 */

export interface CandidateScoreRow {
    id: string;
    candidate_id: string;
    adaptability: number | null;
    fundamentals: number | null;
    depth: number | null;
    production: number | null;
    stack: number | null;
    final_score: number | null;
    confidence: number | null;
    evidence_summary: string | null;
    manual_notes: string | null;
    created_at: string;
    updated_at: string;
}

/** Campos que escribe el análisis con el modelo. */
export interface AnalysisScoreFields {
    scores: CriterionScores;
    finalScore: number;
    confidence: number;
    /** JSON {criteria: {…rationale/evidence}, doubts, risks}. */
    evidenceSummaryJson: string;
}

/** Campos editables manualmente (PATCH /score y POST /notes). */
export interface ManualScoreFields {
    adaptability?: number;
    fundamentals?: number;
    depth?: number;
    production?: number;
    stack?: number;
    confidence?: number;
    manualNotes?: string;
    finalScore?: number;
}

/** Refresco de updated_at en UTC ISO 8601, coherente con los DEFAULT del esquema. */
const NOW_UTC = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

/** Columna SQL por campo manual editable. */
const COLUMN_BY_FIELD: Record<keyof ManualScoreFields, string> = {
    adaptability: "adaptability",
    fundamentals: "fundamentals",
    depth: "depth",
    production: "production",
    stack: "stack",
    confidence: "confidence",
    manualNotes: "manual_notes",
    finalScore: "final_score",
};

@injectable()
export class ScoreRepository {
    constructor(@inject(DB) private readonly db: Database) {}

    findByCandidate(candidateId: string): CandidateScoreRow | undefined {
        return this.db
            .prepare("SELECT * FROM candidate_score WHERE candidate_id = ?")
            .get(candidateId) as CandidateScoreRow | undefined;
    }

    /**
     * Upsert del resultado de un análisis: crea la fila o actualiza los
     * scores sugeridos, confianza y evidence_summary. Las notas manuales
     * (manual_notes) NUNCA se tocan al re-analizar.
     */
    upsertAnalysis(
        candidateId: string,
        fields: AnalysisScoreFields,
    ): CandidateScoreRow {
        this.db
            .prepare(
                `INSERT INTO candidate_score
                     (id, candidate_id, adaptability, fundamentals, depth, production, stack,
                      final_score, confidence, evidence_summary)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT (candidate_id) DO UPDATE SET
                     adaptability = excluded.adaptability,
                     fundamentals = excluded.fundamentals,
                     depth = excluded.depth,
                     production = excluded.production,
                     stack = excluded.stack,
                     final_score = excluded.final_score,
                     confidence = excluded.confidence,
                     evidence_summary = excluded.evidence_summary,
                     updated_at = ${NOW_UTC}`,
            )
            .run(
                newId(),
                candidateId,
                fields.scores.adaptability,
                fields.scores.fundamentals,
                fields.scores.depth,
                fields.scores.production,
                fields.scores.stack,
                fields.finalScore,
                fields.confidence,
                fields.evidenceSummaryJson,
            );
        return this.findByCandidate(candidateId) as CandidateScoreRow;
    }

    /** Crea la fila de score con los campos manuales indicados. */
    createManual(
        candidateId: string,
        fields: ManualScoreFields,
    ): CandidateScoreRow {
        const entries = Object.entries(fields).filter(
            ([, value]) => value !== undefined,
        );
        const columns = entries.map(
            ([key]) => COLUMN_BY_FIELD[key as keyof ManualScoreFields],
        );
        const values = entries.map(([, value]) => value as number | string);
        this.db
            .prepare(
                `INSERT INTO candidate_score (id, candidate_id${columns.map((c) => `, ${c}`).join("")})
                 VALUES (?, ?${", ?".repeat(columns.length)})`,
            )
            .run(newId(), candidateId, ...values);
        return this.findByCandidate(candidateId) as CandidateScoreRow;
    }

    /** Actualización parcial de la fila existente (solo campos definidos). */
    updateManual(
        candidateId: string,
        fields: ManualScoreFields,
    ): CandidateScoreRow {
        const entries = Object.entries(fields).filter(
            ([, value]) => value !== undefined,
        );
        if (entries.length > 0) {
            const sets = entries.map(
                ([key]) =>
                    `${COLUMN_BY_FIELD[key as keyof ManualScoreFields]} = ?`,
            );
            const values = entries.map(([, value]) => value as number | string);
            this.db
                .prepare(
                    `UPDATE candidate_score
                     SET ${sets.join(", ")}, updated_at = ${NOW_UTC}
                     WHERE candidate_id = ?`,
                )
                .run(...values, candidateId);
        }
        return this.findByCandidate(candidateId) as CandidateScoreRow;
    }
}
