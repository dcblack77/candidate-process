# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Comandos

```bash
pnpm install                 # instalar (workspace pnpm: apps/api + apps/web)
pnpm dev                     # API (127.0.0.1:3010) + UI (127.0.0.1:5173) en paralelo
pnpm dev:api / pnpm dev:web  # cada app por separado
pnpm test                    # suite completa; api: 261 tests, web: 16
pnpm --filter api test -- <patrón>   # un spec concreto (p. ej. -- weights, -- cv)
pnpm build                   # tsc estricto + bundle de web
pnpm --filter api lint       # eslint del backend
bash scripts/smoke.sh        # smoke E2E real (requiere API arrancada y modelo en :8080)
```

Los tests del backend usan SQLite `:memory:` y un mock HTTP de llama.cpp — nunca tocan `data/local.db` ni el modelo real. El modelo local (llama.cpp, API OpenAI-compatible, `gemma-4-E2B-it-qat`) debe estar sirviendo en `LLM_BASE_URL` (default `http://localhost:8080`) solo para `pnpm dev` y el smoke.

`BLUEPRINT.md` es la fuente de verdad funcional y de seguridad. Ante cualquier duda de alcance, modelo de datos o reglas, consultarlo antes de improvisar; si una decisión lo contradice, actualizar el blueprint en el mismo cambio.

## Stack y decisiones clave

- **Backend** `apps/api`: ExpressoTS 4 (Express + Inversify). `@inject` SIEMPRE explícito (tsx no emite `design:paramtypes`). Cada dominio es un módulo (controller + usecases + repository); `health/` es el patrón de referencia. El bind a 127.0.0.1 se fuerza en `app.ts` (`forceLocalhostBinding`, con verificación post-arranque que aborta si no es local) porque el adapter no expone host — no tocar sin entender el comentario de ese método.
- **DB**: better-sqlite3 síncrono, SQL directo, migrador propio (`db/migrate.ts` + `db/migrations/NNN_*.sql`). WAL + foreign_keys ON. El single-active-process está forzado por índice único parcial.
- **IA** `apps/api/src/ai/`: `LlmClient` (response_format json_schema + zod, reintentos con temperatura 0.2→0.4, cola de concurrencia 1, presupuesto de tokens). Prompts en `prompts/*.md` (raíz), cargados por `PromptLoader`; los comentarios HTML iniciales se eliminan antes de enviar.
- **Frontend** `apps/web`: React + Vite, sin librerías de estado ni UI kits; CSS global con variables. Proxy `/api` → 127.0.0.1:3010. Tipos espejo de los DTOs en `src/api/types.ts` — si cambia un DTO del backend, actualizar el espejo. La UI escucha en 0.0.0.0 (accesible desde la LAN, decisión explícita del usuario del 2026-07-29; `WEB_HOST=127.0.0.1` la devuelve a solo-local); la API sigue solo en localhost y se alcanza únicamente vía el proxy.
- `scoring/weights.ts` es la ÚNICA fuente de pesos (rúbrica y combinado 30/70) y desempates; el modelo nunca calcula el score final (el backend lo recalcula siempre) y el frontend consume los pesos vía `GET /ranking` (`weights` y `scoreWeights`).
- Límite de 5 regeneraciones de análisis = COUNT de `app_event` con `action='candidate.analyzed'`; 20 preguntas = COUNT en tabla; 10 exports/sesión = contador en memoria.
- Errores: `AppError` con códigos tipados (`shared/errors.ts`) → `{error:{code,message}}`; los errores no controlados se loguean sin mensaje (solo tipo + frames).

## Deuda técnica

Cifrado en reposo de `data/local.db` pendiente (§17) — obligatorio antes de usar datos reales. Ver README.

## Qué es el sistema

Herramienta **local** de evaluación de candidatos para un único rol técnico: carga CVs, extrae texto, genera un resumen estructurado, puntúa contra una rúbrica ponderada con un modelo local, genera preguntas de entrevista con respuestas ideales, produce un ranking y exporta una versión reducida para el líder. El sistema **propone**, no decide contrataciones.

## Invariantes no negociables

Estas reglas vienen de las secciones 04, 08, 10, 16, 17 y 23 del blueprint y condicionan casi todo el código:

- **El CV original nunca se persiste.** Tras extraer texto y resumir, el archivo (PDF/DOCX/TXT) se elimina. No se sirven archivos subidos desde ninguna ruta.
- **Todo el procesamiento de IA es local** (`Gemma4-e2b`). Ningún proveedor externo, ninguna llamada saliente con datos de candidatos.
- **La API solo escucha en `localhost`** y trata todos los datos como privados. Nada expuesto a internet.
- **Toda acción resuelve `currentUser`** (`{ id: "local-admin", role: "admin" }` en MVP) y **valida permisos en backend**, nunca solo ocultando botones. Las funciones `canCreateProcess`, `canUploadCV`, `canAnalyzeCandidate`, `canEditScores`, `canExportResults`, `canDeleteData`, etc. existen desde el inicio aunque todas devuelvan `true`.
- **Nada sensible en logs ni en errores**: ni texto del CV, ni resúmenes completos, ni prompts con datos personales, ni notas privadas.
- **Los exports excluyen por defecto** notas privadas, texto extraído, prompts y datos personales irrelevantes.
- **No persistir datos personales irrelevantes** (foto, edad, dirección, nacionalidad, estado civil) aunque aparezcan en el CV.
- El cierre de proceso ofrece borrado explícito con confirmación de todos los datos derivados.

Si algo de esto no se puede cumplir en una iteración, debe quedar registrado como deuda técnica **antes** de usar datos reales (aplica especialmente al cifrado en reposo de resúmenes, evidencias, notas y resultados).

## Rúbrica y ranking

Cinco criterios, cada uno puntuado de 1 a 5:

| Criterio | Peso | Campo |
|---|---:|---|
| Adaptabilidad | 30% | `adaptability` |
| Fundamentos | 25% | `fundamentals` |
| Profundidad | 20% | `depth` |
| Producción | 15% | `production` |
| Stack (AWS/TypeScript/serverless) | 10% | `stack` |

El score tiene **dos niveles** (§06) y ambos viven en `scoring/weights.ts`:

```text
score_cv    = adaptabilidad*0.30 + fundamentos*0.25 + profundidad*0.20 + produccion*0.15 + stack*0.10
score_final = score_cv*0.30 + (nota_entrevista/2)*0.70     # combinado, DERIVADO
```

`score_cv` (`computeFinalScore`) es lo que promete el CV y es lo único que se persiste (`candidate_score.final_score`). `score_final` (`computeOverallScore`) es lo que el candidato demostró: nunca se persiste, se recalcula en cada lectura, y es lo que ordena el ranking. Sin entrevista puntuada, `score_final = score_cv` y la entrada se marca `provisional: true` (no se penaliza a quien aún no fue entrevistado).

Desempate del combinado, en orden: adaptabilidad → fundamentos → producción → profundidad → stack → **entrevista** → confianza → revisión manual. Los pesos y el orden de desempate viven en un único sitio del código; no duplicarlos.

La **nota de entrevista** (§15) no altera `score_cv` pero pesa el 70% de `score_final`: cada `interview_question` admite `answer_score` (entero 1-10) y `answer_notes` (texto privado). `scoring/interview-score.ts` promedia por criterio y agrega con los pesos de `weights.ts` **renormalizados** sobre los criterios con respuestas; sin respuestas puntuadas vale `null`. Las notas numéricas salen en el export; el texto de `answer_notes` solo con `include.privateNotes`.

`/analyze` **contrasta el CV con la entrevista** (§13): si hay ≥1 respuesta puntuada, `scoring/interview-context.ts` monta el bloque `{{interview_context}}` del prompt (por criterio: pregunta, respuesta ideal, nota 1-10 y notas del evaluador, truncadas a 300/300/400 caracteres) y el modelo debe BAJAR los criterios que no se demostraron. Cada criterio devuelve `verdict` (`confirmed` | `not_demonstrated` | `contradicted` | `not_assessed`), que se persiste en `evidence_summary.criteria[*]`. Sin respuestas puntuadas todo queda en `not_assessed` y el comportamiento es el de siempre; los análisis antiguos sin `verdict` se leen como `null`.

## Arquitectura prevista

```text
/
├── BLUEPRINT.md
├── data/local.db          # persistencia local
├── prompts/               # prompts versionados en el repo
│   ├── summarize-cv.md
│   ├── score-candidate.md
│   ├── generate-questions.md
│   ├── compare-candidates.md
│   └── detect-risks-and-gaps.md
└── src/
    ├── app/               # arranque, rutas HTTP
    ├── ai/                # cliente Gemma4-e2b local, carga de prompts
    ├── candidates/
    ├── cv/                # extracción de texto + borrado del archivo
    ├── export/
    ├── questions/
    ├── ranking/
    ├── scoring/
    ├── security/          # currentUser, capa de permisos
    └── shared/
```

Organización **por dominio, no por capa técnica**. Los prompts son artefactos del repo (`prompts/*.md`), versionados junto al código que los consume — no strings incrustados.

Entidades: `Process`, `Candidate`, `CandidateScore`, `InterviewQuestion`, `AppEvent` (auditoría). Ver §12 del blueprint para los campos exactos. `Candidate` usa `deleted_at` (borrado lógico) además del borrado definitivo al cerrar proceso.

Rutas previstas en §10 del blueprint; el flujo canónico es: crear proceso → añadir candidato → subir CV → `/cv/extract` → `/analyze` → `/questions` → editar `/score` → `/ranking` → `/export` → `/process/close`.

## Reglas de análisis con el modelo

El análisis debe **separar evidencia explícita de inferencia**. No inventar experiencia, no asumir dominio por la simple mención de una tecnología, distinguir exposición superficial de responsabilidad real, y marcar explícitamente qué queda pendiente de validar en entrevista. Cada análisis reporta un **nivel de confianza**.

Cada pregunta generada lleva siempre el bloque completo: pregunta, dimensión, criterio, qué valida, respuesta ideal, señales positivas, señales de alerta y guía de puntuación (ver ejemplo en §14).

## Límites operativos

CV ≤ 10 MB; texto extraído ≤ 50.000 caracteres; ≤ 100 candidatos por proceso; ≤ 5 regeneraciones de análisis por candidato; ≤ 20 preguntas por candidato; ≤ 10 exportaciones por sesión. Rate limiting local por hora: extracción 20, análisis 30, preguntas 60, ranking 30. Formatos aceptados: PDF, DOCX, TXT.

## Fuera de alcance del MVP

Login real, registro público, múltiples usuarios, roles complejos, modelos externos, ATS, emails, calendario, pagos y decisión automática de contratación. Solo un proceso activo a la vez.

## Idioma

Documentación, prompts y comunicación en español. Identificadores de código en inglés (coherente con los nombres de campo del modelo de datos).
