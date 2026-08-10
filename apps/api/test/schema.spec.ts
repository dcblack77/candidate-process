import { beforeEach, describe, expect, it } from "vitest";
import { Database } from "../src/db/database";
import { newId } from "../src/shared/ids";
import { createTestDb } from "./helpers";

describe("esquema migrado completo (sobre :memory:)", () => {
    let db: Database;

    beforeEach(() => {
        db = createTestDb();
    });

    function insertProcess(
        status: "active" | "closed",
        isCurrent = 0,
    ): string {
        const id = newId();
        db.prepare(
            "INSERT INTO process (id, role_title, status, is_current) VALUES (?, ?, ?, ?)",
        ).run(id, "Backend TS", status, isCurrent);
        return id;
    }

    function insertCandidate(processId: string): string {
        const id = newId();
        db.prepare(
            "INSERT INTO candidate (id, process_id, name) VALUES (?, ?, ?)",
        ).run(id, processId, "Candidata Ejemplo");
        return id;
    }

    /**
     * Propuestas de respuesta a partir del audio (005). Lo que se fija aquí
     * es que la base impide estados imposibles: son sugerencias que un humano
     * va a aplicar sobre puntuaciones reales.
     */
    describe("propuestas de entrevista (005)", () => {
        function insertQuestion(candidateId: string): string {
            const id = newId();
            db.prepare(
                `INSERT INTO interview_question (id, candidate_id, criterion, dimension, question)
                 VALUES (?, ?, 'depth', 'investigacion', '¿Pregunta?')`,
            ).run(id, candidateId);
            return id;
        }

        function seed(): { candidateId: string; questionId: string } {
            // Sin marcar como seleccionado: un test puede sembrar varios y el
            // índice único parcial de is_current rechazaría el segundo.
            const processId = insertProcess("active");
            const candidateId = insertCandidate(processId);
            return { candidateId, questionId: insertQuestion(candidateId) };
        }

        function insertProposal(
            fields: Record<string, unknown> = {},
        ): () => void {
            const { candidateId, questionId } = seed();
            const row = {
                id: newId(),
                question_id: questionId,
                candidate_id: candidateId,
                run_id: newId(),
                coverage: "abordado_demostrado",
                proposed_score: 8,
                status: "proposed",
                ...fields,
            };
            return () =>
                db
                    .prepare(
                        `INSERT INTO interview_answer_proposal
                             (id, question_id, candidate_id, run_id, coverage, proposed_score, status)
                         VALUES (@id, @question_id, @candidate_id, @run_id, @coverage, @proposed_score, @status)`,
                    )
                    .run(row);
        }

        it("acepta una propuesta bien formada", () => {
            expect(insertProposal()).not.toThrow();
        });

        it("rechaza niveles de cobertura inventados", () => {
            expect(insertProposal({ coverage: "quiza" })).toThrow(/CHECK/i);
        });

        it("rechaza notas fuera de 1-10 y admite NULL", () => {
            expect(insertProposal({ proposed_score: 11 })).toThrow(/CHECK/i);
            expect(insertProposal({ proposed_score: 0 })).toThrow(/CHECK/i);
            expect(insertProposal({ proposed_score: null })).not.toThrow();
        });

        it("rechaza estados fuera de proposed|applied|dismissed", () => {
            expect(insertProposal({ status: "quizas" })).toThrow(/CHECK/i);
        });

        it("un mismo análisis no propone dos veces sobre la misma pregunta", () => {
            const { candidateId, questionId } = seed();
            const runId = newId();
            const insert = (): void => {
                db.prepare(
                    `INSERT INTO interview_answer_proposal
                         (id, question_id, candidate_id, run_id, coverage)
                     VALUES (?, ?, ?, ?, 'mencionado')`,
                ).run(newId(), questionId, candidateId, runId);
            };
            expect(insert).not.toThrow();
            expect(insert).toThrow(/UNIQUE/i);
        });

        it("borrar el candidato arrastra sus propuestas en cascada", () => {
            const { candidateId, questionId } = seed();
            db.prepare(
                `INSERT INTO interview_answer_proposal
                     (id, question_id, candidate_id, run_id, coverage)
                 VALUES (?, ?, ?, ?, 'mencionado')`,
            ).run(newId(), questionId, candidateId, newId());

            db.prepare("DELETE FROM candidate WHERE id = ?").run(candidateId);
            expect(
                (
                    db
                        .prepare(
                            "SELECT COUNT(*) AS total FROM interview_answer_proposal",
                        )
                        .get() as { total: number }
                ).total,
            ).toBe(0);
        });
    });

    describe("multiproceso: varios abiertos, uno seleccionado", () => {
        it("permite varios procesos activos a la vez (004)", () => {
            insertProcess("active");
            expect(() => insertProcess("active")).not.toThrow();
            expect(
                (
                    db
                        .prepare(
                            "SELECT COUNT(*) AS total FROM process WHERE status = 'active'",
                        )
                        .get() as { total: number }
                ).total,
            ).toBe(2);
        });

        it("permite varios procesos cerrados junto a varios activos", () => {
            insertProcess("closed");
            insertProcess("closed");
            insertProcess("active");
            expect(() => insertProcess("active")).not.toThrow();
        });

        it("rechaza dos procesos seleccionados a la vez (índice único parcial)", () => {
            insertProcess("active", 1);
            expect(() => insertProcess("active", 1)).toThrow(/UNIQUE/i);
        });

        it("permite que no haya ninguno seleccionado", () => {
            insertProcess("active");
            insertProcess("closed");
            expect(
                (
                    db
                        .prepare(
                            "SELECT COUNT(*) AS total FROM process WHERE is_current = 1",
                        )
                        .get() as { total: number }
                ).total,
            ).toBe(0);
        });

        it("rechaza is_current fuera de 0|1", () => {
            expect(() =>
                db
                    .prepare(
                        "INSERT INTO process (id, role_title, is_current) VALUES (?, ?, ?)",
                    )
                    .run(newId(), "Backend TS", 2),
            ).toThrow(/CHECK/i);
        });

        it("rechaza estados fuera de active|closed", () => {
            expect(() =>
                db
                    .prepare(
                        "INSERT INTO process (id, role_title, status) VALUES (?, ?, ?)",
                    )
                    .run(newId(), "Rol", "paused"),
            ).toThrow(/CHECK/i);
        });
    });

    describe("CHECKs de candidate_score", () => {
        function insertScore(adaptability: number): void {
            // Proceso cerrado como soporte: no choca con el índice single-active.
            const processId = insertProcess("closed");
            const candidateId = insertCandidate(processId);
            db.prepare(
                `INSERT INTO candidate_score (id, candidate_id, adaptability)
                 VALUES (?, ?, ?)`,
            ).run(newId(), candidateId, adaptability);
        }

        it("acepta puntuaciones en pasos de 0,5 dentro de 1-5", () => {
            expect(() => insertScore(1)).not.toThrow();
            expect(() => insertScore(2.5)).not.toThrow();
        });

        it("rechaza puntuaciones fuera de 1-5 o con pasos menores de 0,5", () => {
            expect(() => insertScore(0)).toThrow(/CHECK/i);
            expect(() => insertScore(6)).toThrow(/CHECK/i);
            expect(() => insertScore(2.25)).toThrow(/CHECK/i);
        });

        it("rechaza confidence fuera de 0-1", () => {
            const processId = insertProcess("active");
            const candidateId = insertCandidate(processId);
            expect(() =>
                db
                    .prepare(
                        `INSERT INTO candidate_score (id, candidate_id, confidence)
                         VALUES (?, ?, ?)`,
                    )
                    .run(newId(), candidateId, 1.5),
            ).toThrow(/CHECK/i);
        });
    });

    describe("integridad referencial", () => {
        it("borrar un proceso borra en cascada sus candidatos", () => {
            const processId = insertProcess("active");
            insertCandidate(processId);
            db.prepare("DELETE FROM process WHERE id = ?").run(processId);

            const count = db
                .prepare("SELECT COUNT(*) AS total FROM candidate")
                .get() as { total: number };
            expect(count.total).toBe(0);
        });

        it("rechaza candidatos de procesos inexistentes (foreign_keys=ON)", () => {
            expect(() => insertCandidate(newId())).toThrow(/FOREIGN KEY/i);
        });
    });

    describe("interview_question", () => {
        it("rechaza criterios fuera de la rúbrica", () => {
            const processId = insertProcess("active");
            const candidateId = insertCandidate(processId);
            expect(() =>
                db
                    .prepare(
                        `INSERT INTO interview_question (id, candidate_id, criterion, dimension, question)
                         VALUES (?, ?, ?, ?, ?)`,
                    )
                    .run(newId(), candidateId, "carisma", "velocidad", "¿...?"),
            ).toThrow(/CHECK/i);
        });

        describe("respuesta del candidato (002_interview_answers)", () => {
            function insertQuestion(answerScore: number | null): void {
                const processId = insertProcess("closed");
                const candidateId = insertCandidate(processId);
                db.prepare(
                    `INSERT INTO interview_question
                         (id, candidate_id, criterion, dimension, question, answer_score)
                     VALUES (?, ?, 'adaptability', 'velocidad', '¿...?', ?)`,
                ).run(newId(), candidateId, answerScore);
            }

            it("acepta notas de respuesta dentro de 1-10 y NULL", () => {
                expect(() => insertQuestion(1)).not.toThrow();
                expect(() => insertQuestion(10)).not.toThrow();
                expect(() => insertQuestion(null)).not.toThrow();
            });

            it("rechaza notas de respuesta fuera de 1-10 (CHECK del ALTER TABLE)", () => {
                expect(() => insertQuestion(0)).toThrow(/CHECK/i);
                expect(() => insertQuestion(11)).toThrow(/CHECK/i);
            });

            it("las columnas de respuesta nacen a NULL en las preguntas existentes", () => {
                const processId = insertProcess("active");
                const candidateId = insertCandidate(processId);
                const id = newId();
                db.prepare(
                    `INSERT INTO interview_question (id, candidate_id, criterion, dimension, question)
                     VALUES (?, ?, 'stack', 'velocidad', '¿...?')`,
                ).run(id, candidateId);

                const row = db
                    .prepare(
                        "SELECT answer_score, answer_notes, answered_at FROM interview_question WHERE id = ?",
                    )
                    .get(id);
                expect(row).toEqual({
                    answer_score: null,
                    answer_notes: null,
                    answered_at: null,
                });
            });
        });
    });
});
