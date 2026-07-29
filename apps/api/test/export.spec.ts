import supertest from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Database } from "../src/db/database";
import { newId } from "../src/shared/ids";
import { MAX_EXPORTS_PER_SESSION } from "../src/shared/limits";
import { createTestApp, eventsByAction, resetDb, TestApp } from "./app-helpers";

/**
 * Integración de POST /export sobre la app real (sin LLM). El contador de
 * exportaciones por sesión es un singleton del contenedor: el test de límite
 * usa una app aparte para partir de cero.
 */

const SENTINEL_NOTE = "NOTA-PRIVADA-CENTINELA-77";
/** Texto de la respuesta a una pregunta: dato privado (§17). */
const SENTINEL_ANSWER_NOTE = "RESPUESTA-PRIVADA-CENTINELA-88";

describe("POST /export", () => {
    let app: TestApp;
    let db: Database;
    let request: ReturnType<typeof supertest>;

    beforeAll(async () => {
        app = await createTestApp();
        db = app.db;
        request = app.request;
    });

    afterAll(async () => {
        await app.close();
    });

    beforeEach(() => {
        resetDb(db);
    });

    async function createProcess(
        roleTitle = "Backend Sénior Serverless",
    ): Promise<string> {
        const res = await request.post("/process").send({ roleTitle });
        expect(res.status).toBe(201);
        return res.body.id as string;
    }

    async function createCandidate(name: string): Promise<string> {
        const res = await request.post("/candidates").send({ name });
        expect(res.status).toBe(201);
        return res.body.id as string;
    }

    /** Candidato completo: score por PATCH + resumen/evidencias/preguntas sembrados. */
    async function seedScoredCandidate(name: string): Promise<string> {
        const id = await createCandidate(name);
        await request
            .patch(`/candidates/${id}/score`)
            .send({
                adaptability: 5,
                fundamentals: 4,
                depth: 3,
                production: 3,
                stack: 2,
                confidence: 0.8,
            })
            .expect(200);
        await request
            .post(`/candidates/${id}/notes`)
            .send({ notes: SENTINEL_NOTE })
            .expect(200);

        db.prepare("UPDATE candidate SET cv_summary = ? WHERE id = ?").run(
            JSON.stringify({
                professional_summary: `Resumen profesional breve de ${name}.`,
            }),
            id,
        );
        db.prepare(
            "UPDATE candidate_score SET evidence_summary = ? WHERE candidate_id = ?",
        ).run(
            JSON.stringify({
                criteria: {
                    adaptability: {
                        rationale: "Transiciones reales.",
                        evidence: [
                            {
                                text: "FORTALEZA-EXPLICITA: migró Java a Node.",
                                type: "explicit",
                            },
                            {
                                text: "INFERENCIA-DEBIL: quizá lidera equipos.",
                                type: "inferred",
                            },
                        ],
                    },
                },
                doubts: ["Validar profundidad."],
                risks: ["RIESGO: poca operación en producción."],
            }),
            id,
        );
        const questionId = newId();
        db.prepare(
            `INSERT INTO interview_question (id, candidate_id, criterion, dimension, question)
             VALUES (?, ?, 'adaptability', 'velocidad', ?)`,
        ).run(questionId, id, "PREGUNTA-RECOMENDADA: cuéntame una transición.");
        // Respuesta evaluada: nota numérica (no sensible) + texto privado.
        await request
            .patch(`/candidates/${id}/questions/${questionId}/answer`)
            .send({ score: 8, notes: SENTINEL_ANSWER_NOTE })
            .expect(200);
        return id;
    }

    function today(): string {
        return new Date().toISOString().slice(0, 10);
    }

    describe("export por defecto (defaults seguros §17/§19)", () => {
        it("incluye ranking, criterios, resumen, fortalezas explícitas, riesgos y preguntas; NUNCA las notas privadas", async () => {
            await createProcess();
            await seedScoredCandidate("Ana Ejemplo");

            const res = await request.post("/export").send({});

            expect(res.status).toBe(200);
            expect(res.body.format).toBe("markdown");
            expect(res.body.filename).toBe(
                `export-backend-senior-serverless-${today()}.md`,
            );
            expect(res.body.exportsLimit).toBe(MAX_EXPORTS_PER_SESSION);
            expect(typeof res.body.exportsUsedThisSession).toBe("number");

            const content: string = res.body.content;
            expect(content).toContain(
                "# Evaluación de candidatos — Backend Sénior Serverless",
            );
            expect(content).toContain("## Ranking");
            expect(content).toContain("Ana Ejemplo");
            expect(content).toContain("| Adaptabilidad | 30% | 5 |");
            expect(content).toContain(
                "Resumen profesional breve de Ana Ejemplo.",
            );
            expect(content).toContain(
                "FORTALEZA-EXPLICITA: migró Java a Node.",
            );
            expect(content).toContain("RIESGO: poca operación en producción.");
            expect(content).toContain(
                "PREGUNTA-RECOMENDADA: cuéntame una transición.",
            );
            // Las inferencias no son fortalezas.
            expect(content).not.toContain("INFERENCIA-DEBIL");

            // La nota centinela NO aparece por defecto.
            expect(content).not.toContain(SENTINEL_NOTE);
            expect(content).not.toContain("Notas privadas");
            // El TEXTO de la respuesta tampoco (§17), pero su NOTA sí.
            expect(content).not.toContain(SENTINEL_ANSWER_NOTE);
            expect(content).not.toContain("Respuesta anotada");
            expect(content).toContain("nota de la respuesta: 8/10");

            // Auditoría: export.generated sin datos sensibles.
            const events = eventsByAction(db, "export.generated");
            expect(events).toHaveLength(1);
            expect(JSON.parse(events[0].metadata as string)).toEqual({
                candidatesIncluded: 1,
                sensitiveIncluded: false,
            });
            expect(
                eventsByAction(db, "export.included_sensitive"),
            ).toHaveLength(0);
        });

        it("los candidatos sin puntuar aparecen aparte como 'Sin puntuar'", async () => {
            await createProcess();
            await seedScoredCandidate("Con Score");
            await createCandidate("Pendiente Uno");

            const res = await request.post("/export").send({});
            expect(res.status).toBe(200);
            expect(res.body.content).toContain("Sin puntuar: Pendiente Uno.");
        });
    });

    describe("include.privateNotes=true (dato sensible explícito)", () => {
        it("añade las notas y registra export.included_sensitive", async () => {
            await createProcess();
            await seedScoredCandidate("Ana Ejemplo");

            const res = await request
                .post("/export")
                .send({ include: { privateNotes: true } });

            expect(res.status).toBe(200);
            expect(res.body.content).toContain("### Notas privadas");
            expect(res.body.content).toContain(SENTINEL_NOTE);
            // El texto de la respuesta acompaña a su pregunta.
            expect(res.body.content).toContain(
                `- Respuesta anotada: ${SENTINEL_ANSWER_NOTE}`,
            );

            expect(
                eventsByAction(db, "export.included_sensitive"),
            ).toHaveLength(1);
            const generated = eventsByAction(db, "export.generated");
            expect(
                JSON.parse(generated[0].metadata as string).sensitiveIncluded,
            ).toBe(true);
        });
    });

    describe("notas de entrevista (numéricas: no son dato sensible)", () => {
        it("la tabla de ranking lleva columna Entrevista con la nota global", async () => {
            await createProcess();
            await seedScoredCandidate("Ana Ejemplo");

            const res = await request.post("/export").send({});
            expect(res.status).toBe(200);

            const content: string = res.body.content;
            expect(content).toContain(
                "| Posición | Candidato | Score final | Entrevista | Confianza |",
            );
            // Única respuesta puntuada (adaptabilidad, 8) → global 8.0.
            expect(content).toContain(
                "| 1 | Ana Ejemplo | 3.75 | 8.0 | 0.80 |",
            );
        });

        it("la sección por candidato resume la entrevista por criterio", async () => {
            await createProcess();
            await seedScoredCandidate("Ana Ejemplo");

            const content: string = (await request.post("/export").send({}))
                .body.content;
            expect(content).toContain("### Entrevista");
            expect(content).toContain(
                "Nota global de entrevista: **8.0** / 10 (1 de 1 respuestas puntuadas).",
            );
            expect(content).toContain("| Adaptabilidad | 8.0 | 1 |");
            expect(content).toContain("| Stack | — | 0 |");
        });

        it("candidato sin respuestas puntuadas: '—' en la tabla y sin sección de entrevista", async () => {
            await createProcess();
            const id = await createCandidate("Sin Entrevista");
            await request
                .patch(`/candidates/${id}/score`)
                .send({
                    adaptability: 3,
                    fundamentals: 3,
                    depth: 3,
                    production: 3,
                    stack: 3,
                })
                .expect(200);

            const content: string = (await request.post("/export").send({}))
                .body.content;
            expect(content).toContain("| 1 | Sin Entrevista | 3.00 | — | — |");
            expect(content).not.toContain("### Entrevista");
        });
    });

    describe("include.extractedText (decisión: no existe como dato)", () => {
        it("se acepta la clave pero el markdown documenta que el texto no se conserva", async () => {
            await createProcess();
            await seedScoredCandidate("Ana Ejemplo");

            const res = await request
                .post("/export")
                .send({ include: { extractedText: true } });

            expect(res.status).toBe(200);
            expect(res.body.content).toContain(
                "el texto extraído de los CVs no se conserva",
            );
            // No cuenta como sensible: no hay dato real incluido.
            expect(
                eventsByAction(db, "export.included_sensitive"),
            ).toHaveLength(0);
        });
    });

    describe("desactivar secciones", () => {
        it("questions:false y strengths:false las omiten del documento", async () => {
            await createProcess();
            await seedScoredCandidate("Ana Ejemplo");

            const res = await request
                .post("/export")
                .send({ include: { questions: false, strengths: false } });

            expect(res.status).toBe(200);
            expect(res.body.content).not.toContain("PREGUNTA-RECOMENDADA");
            expect(res.body.content).not.toContain("FORTALEZA-EXPLICITA");
            // El resto sigue con sus defaults.
            expect(res.body.content).toContain("## Ranking");
        });
    });

    describe("validación y errores", () => {
        it("include con clave desconocida o valor no booleano responde 400 y no consume el contador", async () => {
            await createProcess();
            await seedScoredCandidate("Ana Ejemplo");

            const before = await request.post("/export").send({});
            expect(before.status).toBe(200);
            const used = before.body.exportsUsedThisSession as number;

            const unknown = await request
                .post("/export")
                .send({ include: { cvOriginal: true } });
            expect(unknown.status).toBe(400);
            expect(unknown.body.error.code).toBe("INVALID_INPUT");

            const nonBoolean = await request
                .post("/export")
                .send({ include: { ranking: "sí" } });
            expect(nonBoolean.status).toBe(400);

            const after = await request.post("/export").send({});
            expect(after.status).toBe(200);
            expect(after.body.exportsUsedThisSession).toBe(used + 1);
        });

        it("sin proceso activo responde 404", async () => {
            const res = await request.post("/export").send({});
            expect(res.status).toBe(404);
            expect(res.body.error.code).toBe("NOT_FOUND");
        });
    });
});

describe("POST /export — límite por sesión (§16: 10)", () => {
    it("la exportación 11 responde 422 LIMIT_EXCEEDED", async () => {
        // App propia: el contador de sesión arranca de cero.
        const app = await createTestApp();
        try {
            await app.request
                .post("/process")
                .send({ roleTitle: "Rol Corto" })
                .expect(201);

            for (let i = 1; i <= MAX_EXPORTS_PER_SESSION; i++) {
                const res = await app.request.post("/export").send({});
                expect(res.status).toBe(200);
                expect(res.body.exportsUsedThisSession).toBe(i);
            }

            const eleventh = await app.request.post("/export").send({});
            expect(eleventh.status).toBe(422);
            expect(eleventh.body.error.code).toBe("LIMIT_EXCEEDED");

            // El límite es por sesión de la API, no por proceso: sigue 422
            // incluso tras recrear el proceso.
            const events = eventsByAction(app.db, "export.generated");
            expect(events).toHaveLength(MAX_EXPORTS_PER_SESSION);
        } finally {
            await app.close();
        }
    });
});
