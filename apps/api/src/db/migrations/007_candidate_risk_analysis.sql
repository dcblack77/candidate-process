-- 007_candidate_risk_analysis.sql — Riesgos y lagunas por candidato
-- (BLUEPRINT §13 "Riesgos y lagunas", 2026-08-15).
--
-- Qué guarda: la ÚLTIMA pasada de detect-risks-and-gaps sobre el resumen
-- del CV de un candidato. Es material para la entrevista (qué preguntar,
-- qué validar), no una conclusión ni una nota: por eso no toca
-- candidate_score ni ningún peso del ranking.
--
-- Una fila por candidato (UNIQUE): regenerar sobrescribe. Las
-- regeneraciones se limitan contando eventos 'candidate.risks_detected'
-- en app_event, igual que las del análisis (§16).
--
-- Contenido sensible (§17): `risks` y `gaps` citan fragmentos del resumen
-- del CV. Cae bajo el mismo cifrado en reposo pendiente que
-- candidate_score.evidence_summary. El ON DELETE CASCADE lo arrastra con el
-- candidato y, por tanto, con la purga del proceso.

CREATE TABLE candidate_risk_analysis (
    id TEXT PRIMARY KEY,
    candidate_id TEXT NOT NULL UNIQUE REFERENCES candidate (id) ON DELETE CASCADE,
    -- Cuánta base real dijo tener el modelo (0-1), igual que en el análisis.
    confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
    -- JSON [{category, criterion, severity, concern, evidence{text,type}, interviewCheck}]
    risks TEXT NOT NULL,
    -- JSON [{criterion, missing, whyItMatters, interviewCheck}]
    gaps TEXT NOT NULL,
    -- JSON con los contadores del verificador de evidencia (cuántos
    -- `explicit` se rebajaron a `inferred`): hace visible cuándo el modelo
    -- citó cosas que el resumen no dice.
    stats TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
