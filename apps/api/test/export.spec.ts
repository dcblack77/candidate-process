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
        // El contador de exports es un singleton de la app: sin resetearlo,
        // los casos se comerían entre ellos el límite de 10 por sesión.
        app.resetExportCounter();
    });

    async function createProcess(
        roleTitle = "Backend Sénior Serverless",
        roleContext?: string,
    ): Promise<string> {
        const res = await request
            .post("/process")
            .send(roleContext === undefined ? { roleTitle } : { roleTitle, roleContext });
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
                    // Con veredicto del contraste CV/entrevista (§13).
                    adaptability: {
                        rationale: "Transiciones reales.",
                        verdict: "confirmed",
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
                    depth: {
                        rationale: "El CV prometía más de lo que demostró.",
                        verdict: "not_demonstrated",
                        evidence: [],
                    },
                    production: {
                        rationale: "La entrevista contradice el CV.",
                        verdict: "contradicted",
                        evidence: [],
                    },
                    // `stack` sin verdict: análisis antiguo, debe tolerarse.
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
            // Tabla por criterio con el veredicto del contraste (§13).
            expect(content).toContain(
                "| Criterio | Peso | Score | Entrevista |",
            );
            expect(content).toContain(
                "| Adaptabilidad | 30% | 5 | ✓ confirmado |",
            );
            expect(content).toContain(
                "| Profundidad | 20% | 3 | ⚠ no demostrado |",
            );
            expect(content).toContain("| Producción | 15% | 3 | ⚠ contradicho |");
            // Criterio sin verdict persistido (análisis antiguo): "—".
            expect(content).toContain("| Stack | 10% | 2 | — |");
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
                format: "markdown",
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
        it("la tabla de ranking lleva CV, Entrevista y Score final combinado", async () => {
            await createProcess();
            await seedScoredCandidate("Ana Ejemplo");

            const res = await request.post("/export").send({});
            expect(res.status).toBe(200);

            const content: string = res.body.content;
            expect(content).toContain(
                "| Posición | Candidato | CV | Entrevista | Score final | Confianza |",
            );
            // Única respuesta puntuada (adaptabilidad, 8) → global 8.0.
            // Combinado: 3.75*0.30 + 4.0*0.70 = 1.125 + 2.8 = 3.93.
            expect(content).toContain(
                "| 1 | Ana Ejemplo | 3.75 | 8.0 | 3.93 | 0.80 |",
            );
            // La nota de la tabla explica los pesos del combinado.
            expect(content).toContain(
                "Score final = CV 30% + entrevista 70% (nota /2, escala 1-5).",
            );
            expect(content).toContain(
                "Pesos de la rúbrica (score de CV): Adaptabilidad 30%",
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

        it("candidato sin respuestas puntuadas: score final provisional, '—' en Entrevista y sin sección de entrevista", async () => {
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
            // Sin entrevista el combinado es el score de CV, marcado con *.
            expect(content).toContain(
                "| 1 | Sin Entrevista | 3.00 | — | 3.00* | — |",
            );
            expect(content).toContain("\\* Score provisional");
            expect(content).toContain(
                "Score final: **3.00** (provisional: sin entrevista puntuada)",
            );
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

    describe("format: 'structured' (datos para la vista de impresión → PDF, §19)", () => {
        it("devuelve los MISMOS datos que el markdown para el mismo include", async () => {
            await createProcess(
                "Backend Sénior Serverless",
                "Equipo pequeño, mucho AWS.",
            );
            await seedScoredCandidate("Ana Ejemplo");
            await createCandidate("Pendiente Uno");

            const markdown = (await request.post("/export").send({})).body;
            const res = await request
                .post("/export")
                .send({ format: "structured" });

            expect(res.status).toBe(200);
            const body = res.body;
            expect(body.format).toBe("structured");
            expect(body.roleTitle).toBe("Backend Sénior Serverless");
            expect(body.roleContext).toBe("Equipo pequeño, mucho AWS.");
            // Pesos desde scoring/weights.ts (única fuente): la UI no los inventa.
            expect(body.weights.adaptability).toBe(0.3);
            expect(body.scoreWeights).toEqual({ cv: 0.3, interview: 0.7 });
            expect(typeof body.generatedAt).toBe("string");
            expect(body.include).toMatchObject({
                ranking: true,
                privateNotes: false,
            });
            expect(body.exportsLimit).toBe(MAX_EXPORTS_PER_SESSION);

            // Mismos candidatos, mismo orden y mismos números que el markdown.
            expect(body.entries).toHaveLength(1);
            expect(body.unscored).toEqual(["Pendiente Uno"]);
            const entry = body.entries[0];
            expect(entry.position).toBe(1);
            expect(entry.name).toBe("Ana Ejemplo");
            expect(entry.cvScore).toBe(3.75);
            expect(entry.overallScore).toBe(3.93);
            expect(entry.provisional).toBe(false);
            expect(entry.confidence).toBe(0.8);
            expect(entry.scores).toEqual({
                adaptability: 5,
                fundamentals: 4,
                depth: 3,
                production: 3,
                stack: 2,
            });
            expect(entry.verdicts.adaptability).toBe("confirmed");
            expect(entry.verdicts.depth).toBe("not_demonstrated");
            // Criterio sin verdict persistido (análisis antiguo).
            expect(entry.verdicts.stack).toBeNull();
            expect(entry.interview.overall).toBe(8);
            expect(entry.questions[0].answerScore).toBe(8);
            expect(entry.doubts).toEqual(["Validar profundidad."]);

            // Todo el texto que sale en el JSON sale también en el markdown.
            const content: string = markdown.content;
            expect(content).toContain(entry.name);
            expect(content).toContain(entry.summary);
            expect(content).toContain(entry.overallScore.toFixed(2));
            for (const strength of entry.strengths) {
                expect(content).toContain(strength);
            }
            for (const risk of entry.risks) {
                expect(content).toContain(risk);
            }
            for (const question of entry.questions) {
                expect(content).toContain(question.question);
            }
            for (const name of body.unscored) {
                expect(content).toContain(name);
            }
        });

        it("las notas privadas NO viajan en el JSON por defecto y sí con el flag", async () => {
            await createProcess();
            await seedScoredCandidate("Ana Ejemplo");

            const safe = await request
                .post("/export")
                .send({ format: "structured" });
            expect(safe.status).toBe(200);
            // Centinela sobre el payload COMPLETO: no basta con no pintarlo.
            const safeJson = JSON.stringify(safe.body);
            expect(safeJson).not.toContain(SENTINEL_NOTE);
            expect(safeJson).not.toContain(SENTINEL_ANSWER_NOTE);
            expect(safe.body.entries[0].manualNotes).toBeNull();
            expect(safe.body.entries[0].questions[0].answerNotes).toBeNull();
            // La nota numérica de la respuesta sí sale (no es dato sensible).
            expect(safe.body.entries[0].questions[0].answerScore).toBe(8);

            const sensitive = await request
                .post("/export")
                .send({ format: "structured", include: { privateNotes: true } });
            expect(sensitive.status).toBe(200);
            expect(sensitive.body.entries[0].manualNotes).toBe(SENTINEL_NOTE);
            expect(sensitive.body.entries[0].questions[0].answerNotes).toBe(
                SENTINEL_ANSWER_NOTE,
            );
            expect(sensitive.body.include.privateNotes).toBe(true);

            // Se sigue auditando la inclusión de datos sensibles (§17).
            const events = eventsByAction(db, "export.included_sensitive");
            expect(events).toHaveLength(1);
            expect(JSON.parse(events[0].metadata as string).format).toBe(
                "structured",
            );
        });

        it("el mismo include filtra igual en los dos formatos", async () => {
            await createProcess();
            await seedScoredCandidate("Ana Ejemplo");

            const include = {
                questions: false,
                strengths: false,
                scoresByCriterion: false,
            };
            const markdown = (await request.post("/export").send({ include }))
                .body;
            const structured = (
                await request
                    .post("/export")
                    .send({ format: "structured", include })
            ).body;

            expect(markdown.content).not.toContain("PREGUNTA-RECOMENDADA");
            expect(markdown.content).not.toContain("FORTALEZA-EXPLICITA");
            const entry = structured.entries[0];
            expect(entry.questions).toEqual([]);
            expect(entry.strengths).toEqual([]);
            expect(entry.scores).toBeNull();
            expect(entry.verdicts).toBeNull();
            // Lo no desactivado sigue en ambos.
            expect(markdown.content).toContain("RIESGO: poca operación");
            expect(entry.risks[0]).toContain("RIESGO: poca operación");
        });

        it("el filename lleva extensión .pdf en structured y .md en markdown", async () => {
            await createProcess();

            const markdown = await request.post("/export").send({});
            expect(markdown.body.filename).toBe(
                `export-backend-senior-serverless-${today()}.md`,
            );

            const structured = await request
                .post("/export")
                .send({ format: "structured" });
            expect(structured.body.filename).toBe(
                `export-backend-senior-serverless-${today()}.pdf`,
            );
        });

        it("audita export.generated con el formato usado", async () => {
            await createProcess();
            await request.post("/export").send({ format: "structured" });

            const events = eventsByAction(db, "export.generated");
            expect(events).toHaveLength(1);
            expect(JSON.parse(events[0].metadata as string)).toEqual({
                candidatesIncluded: 0,
                sensitiveIncluded: false,
                format: "structured",
            });
        });

        it("un format desconocido responde 400 y no consume el contador", async () => {
            await createProcess();

            const before = await request.post("/export").send({});
            const used = before.body.exportsUsedThisSession as number;

            const invalid = await request
                .post("/export")
                .send({ format: "pdf" });
            expect(invalid.status).toBe(400);
            expect(invalid.body.error.code).toBe("INVALID_INPUT");

            const nonString = await request
                .post("/export")
                .send({ format: 42 });
            expect(nonString.status).toBe(400);
            expect(nonString.body.error.code).toBe("INVALID_INPUT");

            const after = await request.post("/export").send({});
            expect(after.body.exportsUsedThisSession).toBe(used + 1);
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

            // El contador es compartido: markdown y structured alternados.
            for (let i = 1; i <= MAX_EXPORTS_PER_SESSION; i++) {
                const res = await app.request
                    .post("/export")
                    .send(i % 2 === 0 ? { format: "structured" } : {});
                expect(res.status).toBe(200);
                expect(res.body.exportsUsedThisSession).toBe(i);
            }

            const eleventh = await app.request.post("/export").send({});
            expect(eleventh.status).toBe(422);
            expect(eleventh.body.error.code).toBe("LIMIT_EXCEEDED");
            // También para la vista de impresión: el límite es del dominio.
            const structured = await app.request
                .post("/export")
                .send({ format: "structured" });
            expect(structured.status).toBe(422);
            expect(structured.body.error.code).toBe("LIMIT_EXCEEDED");

            // El límite es por sesión de la API, no por proceso: sigue 422
            // incluso tras recrear el proceso.
            const events = eventsByAction(app.db, "export.generated");
            expect(events).toHaveLength(MAX_EXPORTS_PER_SESSION);
        } finally {
            await app.close();
        }
    });
});
