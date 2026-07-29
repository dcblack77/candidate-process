import { inject, injectable } from "@expressots/core";
import { GeneratedQuestion } from "../ai/schemas/generate-questions";
import { Database, DB } from "../db/database";
import { newId } from "../shared/ids";

/**
 * Repositorio de interview_question (BLUEPRINT §12 y §14). Las señales
 * positive_signals/warning_signals se guardan como JSON (listas de strings).
 */

export interface InterviewQuestionRow {
    id: string;
    candidate_id: string;
    criterion: string;
    dimension: string;
    question: string;
    validates: string | null;
    ideal_answer: string | null;
    positive_signals: string | null;
    warning_signals: string | null;
    scoring_guidance: string | null;
    created_at: string;
}

@injectable()
export class QuestionRepository {
    constructor(@inject(DB) private readonly db: Database) {}

    countByCandidate(candidateId: string): number {
        const row = this.db
            .prepare(
                "SELECT COUNT(*) AS total FROM interview_question WHERE candidate_id = ?",
            )
            .get(candidateId) as { total: number };
        return row.total;
    }

    listByCandidate(candidateId: string): InterviewQuestionRow[] {
        // rowid = orden de inserción real (created_at empata dentro de un lote).
        return this.db
            .prepare(
                `SELECT * FROM interview_question
                 WHERE candidate_id = ?
                 ORDER BY rowid`,
            )
            .all(candidateId) as InterviewQuestionRow[];
    }

    /** Inserta el lote de preguntas generadas y devuelve las filas creadas. */
    insertMany(
        candidateId: string,
        questions: GeneratedQuestion[],
    ): InterviewQuestionRow[] {
        const insert = this.db.prepare(
            `INSERT INTO interview_question
                 (id, candidate_id, criterion, dimension, question, validates,
                  ideal_answer, positive_signals, warning_signals, scoring_guidance)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        );
        const ids: string[] = [];
        this.db.transaction(() => {
            for (const question of questions) {
                const id = newId();
                ids.push(id);
                insert.run(
                    id,
                    candidateId,
                    question.criterion,
                    question.dimension,
                    question.question,
                    question.validates,
                    question.ideal_answer,
                    JSON.stringify(question.positive_signals),
                    JSON.stringify(question.warning_signals),
                    question.scoring_guidance,
                );
            }
        })();
        const placeholders = ids.map(() => "?").join(", ");
        return this.db
            .prepare(
                `SELECT * FROM interview_question WHERE id IN (${placeholders})
                 ORDER BY rowid`,
            )
            .all(...ids) as InterviewQuestionRow[];
    }
}
