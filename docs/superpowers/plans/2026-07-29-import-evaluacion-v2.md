# Evaluation V2 Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cargar fielmente la evaluación v2 en la SQLite local y admitir una nota de rúbrica revisada a 2,5.

**Architecture:** Una migración genérica reconstruye `candidate_score` para aceptar medios puntos sin perder filas ni claves foráneas. La API y el formulario aplican la misma validación; la carga privada se ejecuta directamente sobre `data/local.db` mediante una transacción y no se versiona.

**Tech Stack:** SQLite, TypeScript, ExpressoTS, React, Vitest.

## Global Constraints

- El PDF es la fuente de verdad del texto revisado.
- No crear campos editoriales nuevos: usar `role_context`, `manual_notes` y `answer_notes`.
- Mantener una nota de respuesta existente cuando sea necesaria para preservar el agregado y el ranking del PDF.
- Permitir criterios de 1 a 5 exclusivamente en pasos de 0,5.
- Respaldar `data/local.db` antes de modificarla.

---

### Task 1: Soporte de medios puntos

**Files:**
- Create: `apps/api/src/db/migrations/003_half_point_scores.sql`
- Modify: `apps/api/src/scoring/scoring.dto.ts`
- Modify: `apps/web/src/pages/CandidateDetailPage.tsx`
- Test: `apps/api/test/schema.spec.ts`
- Test: `apps/api/test/score-edit.spec.ts`
- Test: `apps/web/test/detail.test.tsx`

**Interfaces:**
- Consumes: `PATCH /candidates/:id/score` y `candidate_score` existentes.
- Produces: criterios numéricos `1, 1.5, …, 5` con el score ponderado recalculado.

- [ ] Añadir pruebas que acepten 2,5 y rechacen 2,25 en esquema, API y formulario.
- [ ] Ejecutar las pruebas focalizadas y confirmar el fallo por la restricción actual de enteros.
- [ ] Reconstruir `candidate_score` con columnas `REAL` y CHECK de rango y paso 0,5; copiar todos los datos e índices implícitos.
- [ ] Sustituir la validación de enteros por rango + múltiplo de 0,5 y usar `step={0.5}` en el formulario.
- [ ] Ejecutar de nuevo las pruebas focalizadas hasta que pasen.

### Task 2: Carga privada de la evaluación v2

**Files:**
- Modify (ignored runtime data): `data/local.db`
- Create (ignored backup): `data/local.db.backup-2026-07-29T<timestamp>`

**Interfaces:**
- Consumes: proceso activo y los 16 IDs de preguntas ya existentes.
- Produces: `role_context`, cuatro `manual_notes`, dieciséis `answer_notes` y la nota Producción 2,5 con su score CV recalculado.

- [ ] Crear una copia consistente con la API de backup de SQLite.
- [ ] Aplicar la migración 003 a la base local.
- [ ] Ejecutar una transacción que valide el conjunto esperado y actualice los textos por ID.
- [ ] Actualizar la nota de Producción revisada a 2,5 y su `final_score` mediante la fórmula canónica.
- [ ] Consultar la base y verificar conteos, scores, entrevista 4,3 y presencia de todas las notas.

### Task 3: Verificación integral

**Files:**
- Modify: `BLUEPRINT.md`
- Modify: `CLAUDE.md`

**Interfaces:**
- Consumes: nuevo dominio de puntuación de medio punto.
- Produces: documentación coherente y una compilación verificable.

- [ ] Actualizar la documentación de la rúbrica de “enteros 1-5” a “pasos de 0,5 entre 1 y 5”.
- [ ] Ejecutar `pnpm test` y confirmar cero fallos.
- [ ] Ejecutar `pnpm build` y confirmar salida 0.
- [ ] Revisar `git diff`, confirmar que no contiene datos personales del PDF y volver a consultar la SQLite local.
