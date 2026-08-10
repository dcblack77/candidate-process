import { inject, injectable } from "@expressots/core";
import { Database, DB } from "../db/database";
import { newId } from "../shared/ids";
import {
    CoverageLevel,
    ProposalQuoteDTO,
    ProposalStatus,
} from "./interview.dto";

/**
 * Repositorio de propuestas de respuesta (BLUEPRINT §24, migración 005).
 *
 * Esta tabla NUNCA es la fuente de verdad de la puntuación: la nota real vive
 * en `interview_question.answer_score` y solo la escribe el evaluador con el
 * PATCH de siempre. Aquí solo se guarda lo que el sistema PROPONE.
 */

export interface ProposalRow {
    id: string;
    question_id: string;
    candidate_id: string;
    run_id: string;
    coverage: CoverageLevel;
    proposed_score: number | null;
    proposed_notes: string | null;
    evidence: string | null;
    confidence: number | null;
    status: ProposalStatus;
    created_at: string;
    resolved_at: string | null;
}

/** Propuesta a insertar, ya verificada y normalizada por el runner. */
export interface ProposalInput {
    questionId: string;
    coverage: CoverageLevel;
    proposedScore: number | null;
    proposedNotes: string | null;
    evidence: ProposalQuoteDTO[];
    confidence: number | null;
}

@injectable()
export class ProposalRepository {
    constructor(@inject(DB) private readonly db: Database) {}

    /** Propuestas VIVAS de un candidato, la más reciente primero. */
    listProposedForCandidate(candidateId: string): ProposalRow[] {
        return this.db
            .prepare(
                `SELECT * FROM interview_answer_proposal
                  WHERE candidate_id = ? AND status = 'proposed'
                  ORDER BY created_at DESC`,
            )
            .all(candidateId) as ProposalRow[];
    }

    findByIdForCandidate(
        id: string,
        candidateId: string,
    ): ProposalRow | undefined {
        return this.db
            .prepare(
                "SELECT * FROM interview_answer_proposal WHERE id = ? AND candidate_id = ?",
            )
            .get(id, candidateId) as ProposalRow | undefined;
    }

    /**
     * Guarda el resultado de un análisis.
     *
     * Las propuestas vivas anteriores de esas mismas preguntas pasan a
     * `dismissed` en la MISMA transacción: la pantalla muestra siempre como
     * mucho una propuesta viva por pregunta, y un reanálisis no deja dos
     * sugerencias contradictorias compitiendo.
     */
    replaceForRun(
        candidateId: string,
        runId: string,
        proposals: ProposalInput[],
    ): ProposalRow[] {
        const dismissPrevious = this.db.prepare(
            `UPDATE interview_answer_proposal
                SET status = 'dismissed',
                    resolved_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
              WHERE question_id = ? AND status = 'proposed'`,
        );
        const insert = this.db.prepare(
            `INSERT INTO interview_answer_proposal
                 (id, question_id, candidate_id, run_id, coverage, proposed_score,
                  proposed_notes, evidence, confidence)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        );

        const ids: string[] = [];
        this.db.transaction(() => {
            for (const proposal of proposals) {
                dismissPrevious.run(proposal.questionId);
                const id = newId();
                ids.push(id);
                insert.run(
                    id,
                    proposal.questionId,
                    candidateId,
                    runId,
                    proposal.coverage,
                    proposal.proposedScore,
                    proposal.proposedNotes,
                    proposal.evidence.length > 0
                        ? JSON.stringify(proposal.evidence)
                        : null,
                    proposal.confidence,
                );
            }
        })();

        if (ids.length === 0) {
            return [];
        }
        const placeholders = ids.map(() => "?").join(", ");
        return this.db
            .prepare(
                `SELECT * FROM interview_answer_proposal
                  WHERE id IN (${placeholders}) ORDER BY rowid`,
            )
            .all(...ids) as ProposalRow[];
    }

    /** Marca una propuesta como aplicada o descartada. */
    resolve(id: string, status: "applied" | "dismissed"): ProposalRow {
        this.db
            .prepare(
                `UPDATE interview_answer_proposal
                    SET status = ?,
                        resolved_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                  WHERE id = ?`,
            )
            .run(status, id);
        return this.db
            .prepare("SELECT * FROM interview_answer_proposal WHERE id = ?")
            .get(id) as ProposalRow;
    }
}
