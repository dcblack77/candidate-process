-- 003_half_point_scores.sql — La revisión humana de la rúbrica puede usar
-- medios puntos (1, 1.5, …, 5). Se reconstruye la tabla porque SQLite no
-- permite modificar el CHECK de una columna existente.

CREATE TABLE candidate_score_half_points (
    id TEXT PRIMARY KEY,
    candidate_id TEXT NOT NULL UNIQUE REFERENCES candidate (id) ON DELETE CASCADE,
    adaptability REAL CHECK (
        adaptability BETWEEN 1 AND 5
        AND adaptability * 2 = CAST(adaptability * 2 AS INTEGER)
    ),
    fundamentals REAL CHECK (
        fundamentals BETWEEN 1 AND 5
        AND fundamentals * 2 = CAST(fundamentals * 2 AS INTEGER)
    ),
    depth REAL CHECK (
        depth BETWEEN 1 AND 5
        AND depth * 2 = CAST(depth * 2 AS INTEGER)
    ),
    production REAL CHECK (
        production BETWEEN 1 AND 5
        AND production * 2 = CAST(production * 2 AS INTEGER)
    ),
    stack REAL CHECK (
        stack BETWEEN 1 AND 5
        AND stack * 2 = CAST(stack * 2 AS INTEGER)
    ),
    final_score REAL,
    confidence REAL CHECK (confidence BETWEEN 0 AND 1),
    evidence_summary TEXT,
    manual_notes TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

INSERT INTO candidate_score_half_points (
    id, candidate_id, adaptability, fundamentals, depth, production, stack,
    final_score, confidence, evidence_summary, manual_notes, created_at, updated_at
)
SELECT
    id, candidate_id, adaptability, fundamentals, depth, production, stack,
    final_score, confidence, evidence_summary, manual_notes, created_at, updated_at
FROM candidate_score;

DROP TABLE candidate_score;
ALTER TABLE candidate_score_half_points RENAME TO candidate_score;
