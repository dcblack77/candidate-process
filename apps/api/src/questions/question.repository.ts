import { inject, injectable } from "@expressots/core";
import { GeneratedQuestion } from "../ai/schemas/generate-questions";
import { Database, DB } from "../db/database";
import { newId } from "../shared/ids";

/**
 * Repositorio de interview_question (BLUEPRINT §12 y §14). Las señales
 * positive_signals/warning_signals se guardan como JSON (listas de strings).
 *
 * Desde 002_interview_answers también guarda la RESPUESTA del candidato:
 * nota 1-10 (answer_score) y notas privadas de texto (answer_notes).
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
    /** Nota de la respuesta, entero 1-10; null si no está puntuada. */
    answer_score: number | null;
    /** Notas privadas sobre lo que respondió (dato sensible §17). */
    answer_notes: string | null;
    /** ISO 8601 UTC del último registro de respuesta; null si no hay respuesta. */
    answered_at: string | null;
}

/** Refresco de answered_at en UTC ISO 8601, coherente con los DEFAULT del esquema. */
const NOW_UTC = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

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

    /**
     * Busca una pregunta EXIGIENDO que pertenezca al candidato indicado. Si
     * el id existe pero es de otro candidato devuelve undefined (el caso de
     * uso responde 404 sin revelar que la pregunta existe).
     */
    findByIdForCandidate(
        questionId: string,
        candidateId: string,
    ): InterviewQuestionRow | undefined {
        return this.db
            .prepare(
                "SELECT * FROM interview_question WHERE id = ? AND candidate_id = ?",
            )
            .get(questionId, candidateId) as InterviewQuestionRow | undefined;
    }

    /**
     * Fija la respuesta de una pregunta (nota y/o notas de texto ya
     * fusionadas por el caso de uso) y actualiza answered_at en UTC.
     * Si la pregunta queda sin nota Y sin texto, answered_at vuelve a NULL:
     * deja de estar respondida.
     */
    setAnswer(
        questionId: string,
        answerScore: number | null,
        answerNotes: string | null,
    ): InterviewQuestionRow {
        this.db
            .prepare(
                `UPDATE interview_question
                 SET answer_score = ?,
                     answer_notes = ?,
                     answered_at = CASE
                         WHEN ? IS NULL AND ? IS NULL THEN NULL
                         ELSE ${NOW_UTC}
                     END
                 WHERE id = ?`,
            )
            .run(
                answerScore,
                answerNotes,
                answerScore,
                answerNotes,
                questionId,
            );
        return this.db
            .prepare("SELECT * FROM interview_question WHERE id = ?")
            .get(questionId) as InterviewQuestionRow;
    }

    /**
     * Borra una pregunta. Las propuestas del análisis de audio que cuelguen
     * de ella se van por CASCADE (migración 005). El caso de uso ya comprobó
     * pertenencia y que no tenga respuesta.
     */
    delete(questionId: string): void {
        this.db
            .prepare("DELETE FROM interview_question WHERE id = ?")
            .run(questionId);
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
                    // `validates` ya no se pide al modelo (2026-08-07): repetía
                    // la pregunta. La columna se mantiene para las filas viejas.
                    null,
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
