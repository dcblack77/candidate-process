-- 006_interview_recordings.sql — Grabaciones de entrevista conservadas en
-- disco (decisión del 2026-08-10, BLUEPRINT §24; deroga parte de §17).
--
-- Problema que resuelve: el job de análisis vive en memoria y solo hay uno a
-- la vez. Si moría a medias —reinicio del backend, timeout, cancelación
-- accidental— se perdía TODO el trabajo y, peor, el audio: el navegador lo
-- tenía en RAM y ya no estaba, así que no había forma de reintentar. En una
-- entrevista real eso significa perder la evaluación de un candidato al que
-- no se puede volver a entrevistar.
--
-- Qué cambia respecto a §17: el audio y la transcripción SÍ se persisten
-- ahora. No en esta tabla —viven como archivos bajo RECORDINGS_DIR— sino
-- referenciados desde aquí. Es una derogación consciente de la regla que
-- decía que solo las citas tocaban el disco.
--
-- Qué guarda esta tabla:
--
-- - SÍ: dónde están los archivos, qué pista es la del candidato, cuánto dura,
--   cuántos segmentos salieron y cómo acabó el último análisis.
-- - NO: el audio ni el texto. Esta tabla es un índice, no el contenido.
--
-- Retención: NO hay purga automática (decisión explícita del usuario). Una
-- grabación vive hasta que alguien la borra —desde la pantalla del candidato
-- o purgando el proceso—. El ON DELETE CASCADE limpia la fila; los archivos
-- los borra el usecase ANTES, porque SQLite no sabe de disco.

CREATE TABLE interview_recording (
    id TEXT PRIMARY KEY,
    candidate_id TEXT NOT NULL REFERENCES candidate (id) ON DELETE CASCADE,
    -- Desnormalizado como en interview_answer_proposal: permite recoger las
    -- grabaciones de un proceso para borrar sus archivos ANTES de que el
    -- CASCADE se lleve las filas por delante.
    process_id TEXT NOT NULL REFERENCES process (id) ON DELETE CASCADE,
    -- Cuál de las dos pistas es la voz del candidato. Sin esto la
    -- transcripción no se puede reatribuir al reanalizar, y confundir al
    -- entrevistador con el candidato es el falso positivo que §24 evita.
    candidate_source TEXT NOT NULL CHECK (candidate_source IN ('mic', 'tab')),
    -- JSON [{label,speaker,file,bytes}] — descriptor de los archivos.
    tracks TEXT NOT NULL,
    -- Cuándo se guardó la transcripción; NULL si el job murió antes de que
    -- whisper terminara. Es justo la señal que decide si un reintento puede
    -- saltarse la transcripción o tiene que rehacerla.
    transcript_at TEXT,
    duration_sec REAL,
    segments INTEGER,
    -- Cómo acabó el último análisis lanzado sobre esta grabación. Es lo que
    -- hace visible "algo falló" sin tener que mirar logs.
    last_run_id TEXT,
    last_status TEXT CHECK (last_status IS NULL OR last_status IN (
        'running',
        'done',
        'failed',
        'cancelled'
    )),
    -- Solo el CÓDIGO tipado del error, nunca un mensaje: los mensajes de este
    -- dominio pueden llevar transcripción de una persona real (§17).
    last_error_code TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_recording_candidate
    ON interview_recording (candidate_id, created_at DESC);

CREATE INDEX idx_recording_process ON interview_recording (process_id);
