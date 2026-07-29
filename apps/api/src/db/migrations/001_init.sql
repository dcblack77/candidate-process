-- 001_init.sql — Esquema inicial (BLUEPRINT §12 + plan "Esquema SQL").
-- Timestamps en ISO 8601 UTC vía strftime. Ids: UUID v4 en TEXT.

-- Proceso de selección: solo puede haber UNO activo (índice único parcial).
CREATE TABLE process (
    id TEXT PRIMARY KEY,
    role_title TEXT NOT NULL,
    role_context TEXT,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'closed')),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    closed_at TEXT
);

-- Invariante §16: solo un proceso activo en MVP, forzado en base de datos.
CREATE UNIQUE INDEX idx_process_single_active ON process (status) WHERE status = 'active';

-- Candidato con borrado lógico (deleted_at) además del borrado en cascada
-- al cerrar/borrar el proceso.
CREATE TABLE candidate (
    id TEXT PRIMARY KEY,
    process_id TEXT NOT NULL REFERENCES process (id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    cv_summary TEXT,   -- JSON: resumen estructurado del CV (nunca el CV original)
    cv_evidence TEXT,  -- JSON: evidencias por criterio
    analysis_status TEXT NOT NULL DEFAULT 'pending'
        CHECK (analysis_status IN ('pending', 'extracting', 'summarized', 'analyzing', 'analyzed', 'failed')),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    deleted_at TEXT
);

CREATE INDEX idx_candidate_process ON candidate (process_id);

-- Puntuación por candidato (una fila por candidato). Cada criterio 1-5.
CREATE TABLE candidate_score (
    id TEXT PRIMARY KEY,
    candidate_id TEXT NOT NULL UNIQUE REFERENCES candidate (id) ON DELETE CASCADE,
    adaptability INTEGER CHECK (adaptability BETWEEN 1 AND 5),
    fundamentals INTEGER CHECK (fundamentals BETWEEN 1 AND 5),
    depth INTEGER CHECK (depth BETWEEN 1 AND 5),
    production INTEGER CHECK (production BETWEEN 1 AND 5),
    stack INTEGER CHECK (stack BETWEEN 1 AND 5),
    final_score REAL,
    confidence REAL CHECK (confidence BETWEEN 0 AND 1),
    evidence_summary TEXT, -- JSON
    manual_notes TEXT,     -- notas privadas del evaluador (nunca en exports por defecto)
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Pregunta de entrevista con el bloque completo de §14.
-- `validates` ("qué busca validar") se añade respecto a §12 porque §14 lo exige.
CREATE TABLE interview_question (
    id TEXT PRIMARY KEY,
    candidate_id TEXT NOT NULL REFERENCES candidate (id) ON DELETE CASCADE,
    criterion TEXT NOT NULL
        CHECK (criterion IN ('adaptability', 'fundamentals', 'depth', 'production', 'stack')),
    dimension TEXT NOT NULL,
    question TEXT NOT NULL,
    validates TEXT,
    ideal_answer TEXT,
    positive_signals TEXT, -- JSON (lista de señales)
    warning_signals TEXT,  -- JSON (lista de señales)
    scoring_guidance TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_interview_question_candidate ON interview_question (candidate_id);

-- Auditoría de acciones. metadata: JSON SOLO con ids, contadores y duraciones.
-- Jamás contenido de CVs, resúmenes ni notas (BLUEPRINT §17).
CREATE TABLE app_event (
    id TEXT PRIMARY KEY,
    action TEXT NOT NULL,
    entity_type TEXT,
    entity_id TEXT,
    metadata TEXT, -- JSON
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_app_event_action ON app_event (action);
CREATE INDEX idx_app_event_entity ON app_event (entity_type, entity_id);
