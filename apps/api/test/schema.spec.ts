import { beforeEach, describe, expect, it } from "vitest";
import { Database } from "../src/db/database";
import { newId } from "../src/shared/ids";
import { createTestDb } from "./helpers";

describe("esquema (001_init + 002_interview_answers, sobre :memory:)", () => {
    let db: Database;

    beforeEach(() => {
        db = createTestDb();
    });

    function insertProcess(status: "active" | "closed"): string {
        const id = newId();
        db.prepare(
            "INSERT INTO process (id, role_title, status) VALUES (?, ?, ?)",
        ).run(id, "Backend TS", status);
        return id;
    }

    function insertCandidate(processId: string): string {
        const id = newId();
        db.prepare(
            "INSERT INTO candidate (id, process_id, name) VALUES (?, ?, ?)",
        ).run(id, processId, "Candidata Ejemplo");
        return id;
    }

    describe("single-active de process", () => {
        it("rechaza un segundo proceso activo (índice único parcial)", () => {
            insertProcess("active");
            expect(() => insertProcess("active")).toThrow(/UNIQUE/i);
        });

        it("permite varios procesos cerrados junto a uno activo", () => {
            insertProcess("closed");
            insertProcess("closed");
            expect(() => insertProcess("active")).not.toThrow();
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

        it("acepta puntuaciones dentro de 1-5", () => {
            expect(() => insertScore(1)).not.toThrow();
        });

        it("rechaza puntuaciones fuera de 1-5", () => {
            expect(() => insertScore(0)).toThrow(/CHECK/i);
            expect(() => insertScore(6)).toThrow(/CHECK/i);
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
