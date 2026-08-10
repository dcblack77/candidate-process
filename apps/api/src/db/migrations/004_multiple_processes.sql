-- 004_multiple_processes.sql — Varios procesos abiertos a la vez
-- (decisión del 2026-08-07; deroga el "solo un proceso activo" de §16).
--
-- Dos cambios de fondo:
--
-- 1. Desaparece el índice único parcial que impedía tener más de un proceso
--    en estado 'active'. A partir de aquí puede haber N procesos abiertos.
--
-- 2. Aparece `is_current`: cuál es el proceso SELECCIONADO. Es estado
--    compartido por todos los clientes (decisión explícita del usuario), no
--    una preferencia por navegador: si alguien lo cambia desde otro equipo,
--    cambia para todos. El índice único parcial garantiza que no haya dos
--    seleccionados a la vez; que no haya ninguno es válido (base recién
--    creada, o se borró el que estaba seleccionado y no quedan procesos).
--
-- `status` recupera su sentido: hasta ahora 'closed' era inalcanzable porque
-- cerrar borraba la fila. Desde ahora cerrar ARCHIVA (status='closed' +
-- closed_at) conservando los datos, y borrar es una acción aparte.
--
-- Solo añade una columna y cambia índices: no reescribe ni borra datos
-- existentes (hay una base real en data/local.db).

DROP INDEX IF EXISTS idx_process_single_active;

-- 0/1. CHECK admitido en ADD COLUMN (ver nota de 002); el default constante
-- deja las filas existentes como no seleccionadas antes del UPDATE de abajo.
ALTER TABLE process
    ADD COLUMN is_current INTEGER NOT NULL DEFAULT 0
    CHECK (is_current IN (0, 1));

-- Como mucho un proceso seleccionado. Última línea de defensa frente a
-- carreras, igual que hacía idx_process_single_active con 'active'.
CREATE UNIQUE INDEX idx_process_single_current
    ON process (is_current) WHERE is_current = 1;

-- Continuidad: el proceso que estaba activo pasa a ser el seleccionado.
-- El LIMIT 1 es defensivo (el índice viejo ya garantizaba como mucho uno).
UPDATE process SET is_current = 1
WHERE id = (
    SELECT id FROM process WHERE status = 'active'
    ORDER BY created_at LIMIT 1
);
