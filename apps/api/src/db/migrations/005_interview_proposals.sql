-- 005_interview_proposals.sql — Propuestas de respuesta a partir del audio de
-- la entrevista (decisión del 2026-08-07, BLUEPRINT §24).
--
-- Problema que resuelve: hoy solo se puede puntuar una pregunta que se haya
-- formulado. En entrevistas reales el candidato aborda temas sin que se le
-- pregunte, y esas preguntas se quedan en blanco pese a estar cubiertas. Como
-- la nota de entrevista pesa el 70% del score final (§06), distorsiona el
-- ranking.
--
-- Qué se guarda aquí y qué NO:
--
-- - SÍ: la propuesta (cobertura, nota sugerida, notas sugeridas) y hasta 3
--   citas cortas que la respaldan. Sin cita verificable el evaluador no puede
--   auditar de dónde salió la nota, y "el sistema propone, el humano decide"
--   se quedaría en un acto de fe.
-- - NO: el audio ni la transcripción completa. Viven en RAM durante el job y
--   se destruyen al terminar, igual que el CV original (§17). `evidence` es la
--   ÚNICA transcripción literal que toca el disco.
--
-- `proposed_notes` y `evidence` son datos PRIVADOS al mismo nivel que
-- `interview_question.answer_notes`: fuera de los exports por defecto.
--
-- Aplicar una propuesta NO se hace aquí: se dispara el PATCH de siempre sobre
-- `interview_question` y esta fila solo pasa a 'applied'. Esta tabla nunca es
-- la fuente de verdad de la puntuación.

CREATE TABLE interview_answer_proposal (
    id TEXT PRIMARY KEY,
    question_id TEXT NOT NULL REFERENCES interview_question (id) ON DELETE CASCADE,
    -- Desnormalizado a propósito: permite resolver "esta propuesta no es de
    -- este candidato" (404) con una sola consulta, sin join.
    candidate_id TEXT NOT NULL REFERENCES candidate (id) ON DELETE CASCADE,
    -- Id del análisis que la generó: agrupa las propuestas de una misma tanda.
    run_id TEXT NOT NULL,
    coverage TEXT NOT NULL CHECK (coverage IN (
        'no_abordado',
        'mencionado',           -- se nombra el tema sin contenido propio: NO es cobertura
        'abordado_parcial',
        'abordado_demostrado'
    )),
    -- NULL salvo que la cobertura sea abordado_*: el código lo anula.
    proposed_score INTEGER CHECK (
        proposed_score IS NULL OR proposed_score BETWEEN 1 AND 10
    ),
    proposed_notes TEXT,  -- dato PRIVADO (§17)
    evidence TEXT,        -- JSON [{quote,startSec,endSec}] — dato PRIVADO (§17)
    confidence REAL CHECK (confidence IS NULL OR confidence BETWEEN 0 AND 1),
    status TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN (
        'proposed',
        'applied',
        'dismissed'
    )),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    -- Cuándo se aplicó o se descartó; NULL mientras siga viva.
    resolved_at TEXT
);

CREATE INDEX idx_proposal_question ON interview_answer_proposal (question_id);
CREATE INDEX idx_proposal_candidate ON interview_answer_proposal (candidate_id);

-- Un análisis no puede proponer dos veces sobre la misma pregunta.
CREATE UNIQUE INDEX idx_proposal_question_run
    ON interview_answer_proposal (question_id, run_id);
