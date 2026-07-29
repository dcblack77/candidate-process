-- 002_interview_answers.sql — Nota y notas de la RESPUESTA del candidato a
-- cada pregunta de entrevista (BLUEPRINT §07, §15 y §17).
--
-- Motivación: diferenciar candidatos empatados en el score de CV usando lo
-- que respondieron en la entrevista. La fórmula del score final (§06) NO
-- cambia: la entrevista solo entra como criterio de desempate.
--
-- Solo añade columnas: no reescribe ni borra datos existentes (hay una BD
-- real en data/local.db). El migrador la aplica una única vez (_migrations).
--
-- Nota sobre el CHECK: SQLite SÍ admite CHECK en ALTER TABLE ADD COLUMN
-- (verificado sobre la versión embebida en better-sqlite3, 3.53.x); las
-- restricciones de ADD COLUMN son PRIMARY KEY/UNIQUE, NOT NULL sin default y
-- defaults no constantes. Aun así la validación se repite en código
-- (questions.dto.ts) porque el error de la API debe ser INVALID_INPUT (400)
-- y no un fallo de constraint.

-- Nota de la respuesta: entero 1-10 (10 = respuesta que más se ajusta a lo
-- esperado). NULL = pregunta sin puntuar.
ALTER TABLE interview_question
    ADD COLUMN answer_score INTEGER
    CHECK (answer_score IS NULL OR answer_score BETWEEN 1 AND 10);

-- Notas de texto PRIVADAS sobre lo que respondió el candidato.
-- Dato sensible (§17): excluido de los exports salvo include.privateNotes.
ALTER TABLE interview_question ADD COLUMN answer_notes TEXT;

-- Marca temporal (ISO 8601 UTC) de la última vez que se registró respuesta.
-- NULL si la pregunta no tiene ni nota ni texto de respuesta.
ALTER TABLE interview_question ADD COLUMN answered_at TEXT;
