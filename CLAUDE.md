# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Comandos

```bash
pnpm install                 # instalar (workspace pnpm: apps/api + apps/web)
pnpm dev                     # API (127.0.0.1:$API_PORT, 3010 por defecto) + UI (:5173)
pnpm dev:api / pnpm dev:web  # cada app por separado
pnpm test                    # suite completa; api: 441 tests, web: 84
pnpm --filter api test -- <patrón>   # un spec concreto (p. ej. -- weights, -- cv)
pnpm build                   # tsc estricto + bundle de web
pnpm --filter api lint       # eslint del backend
bash scripts/smoke.sh        # smoke E2E real (requiere API arrancada y modelo en :8080)
```

Los tests del backend usan SQLite `:memory:` y un mock HTTP de llama.cpp — nunca tocan `data/local.db` ni el modelo real. El modelo local (llama.cpp, API OpenAI-compatible, `gemma-4-E2B-it-qat`) debe estar sirviendo en `LLM_BASE_URL` (default `http://localhost:8080`) solo para `pnpm dev` y el smoke.

`BLUEPRINT.md` es la fuente de verdad funcional y de seguridad. Ante cualquier duda de alcance, modelo de datos o reglas, consultarlo antes de improvisar; si una decisión lo contradice, actualizar el blueprint en el mismo cambio.

## Stack y decisiones clave

- **Backend** `apps/api`: ExpressoTS 4 (Express + Inversify). `@inject` SIEMPRE explícito (tsx no emite `design:paramtypes`). Cada dominio es un módulo (controller + usecases + repository); `health/` es el patrón de referencia. El bind a 127.0.0.1 se fuerza en `app.ts` (`forceLocalhostBinding`, con verificación post-arranque que aborta si no es local) porque el adapter no expone host — no tocar sin entender el comentario de ese método.
- **DB**: better-sqlite3 síncrono, SQL directo, migrador propio (`db/migrate.ts` + `db/migrations/NNN_*.sql`). WAL + foreign_keys ON. Puede haber **varios procesos abiertos**; lo que fuerza el índice único parcial (`idx_process_single_current`, migración 004) es que solo uno esté SELECCIONADO (`process.is_current`).
- **Multiproceso** (2026-08-07, deroga el "solo un proceso activo" de §16): `process.is_current` marca el proceso sobre el que operan todos los demás dominios. Es estado de **servidor compartido**: cambiarlo desde un equipo de la LAN lo cambia para todos (decisión explícita del usuario frente a una selección por cliente). Las guardas viven en `process.repository.ts`: `requireCurrentProcess` en los usecases de LECTURA (listar/ver candidatos, ranking, export) y `requireWritableProcess` en los de ESCRITURA, que rechaza con `PROCESS_CLOSED` (409) si el proceso está archivado. Al añadir un usecase nuevo hay que elegir una de las dos conscientemente.
- **Archivar ≠ borrar**: `POST /process/close` archiva (`status='closed'` + `closed_at`) conservando todos los datos en solo lectura, es reversible con `POST /process/:id/reopen` y NO pide confirmación. Purgar es `DELETE /process[/:id]` con `confirmDelete: true`. Si se borra el proceso seleccionado, el repositorio selecciona el más reciente que quede para no dejar la app apuntando a nada.
- **IA** `apps/api/src/ai/`: `LlmClient` (response_format json_schema + zod, reintentos con temperatura 0.2→0.4, cola de concurrencia 1, presupuesto de tokens). Prompts en `prompts/*.md` (raíz), cargados por `PromptLoader`; los comentarios HTML iniciales se eliminan antes de enviar.
- **Frontend** `apps/web`: React + Vite, sin librerías de estado ni UI kits; CSS global con variables. Proxy `/api` → 127.0.0.1:3010. Tipos espejo de los DTOs en `src/api/types.ts` — si cambia un DTO del backend, actualizar el espejo. La UI escucha en 0.0.0.0 (accesible desde la LAN, decisión explícita del usuario del 2026-07-29; `WEB_HOST=127.0.0.1` la devuelve a solo-local); la API sigue solo en localhost y se alcanza únicamente vía el proxy.
- **HTTPS del servidor de desarrollo** (2026-08-08, `apps/web/dev/tls.ts`): certificado autofirmado generado y cacheado en `certs/`. NO es una medida de seguridad —sigue sin haber autenticación— sino el único modo de que el navegador dé acceso al micrófono fuera de localhost; sin esto, grabar la entrevista (§24) desde la LAN es imposible y no hay bandera que lo desactive, porque la restricción es del navegador. Los SAN incluyen todas las IPv4 no internas y el certificado se regenera solo cuando caduca o cambia la IP; el resto del tiempo se reutiliza para no invalidar la excepción que aceptó cada navegador. Se salta en tests y builds (`process.env.VITEST`, `command !== "serve"`) y, si falla, se arranca en HTTP con un aviso en vez de tumbar el servidor. `WEB_HTTPS=false` lo desactiva.
- El contexto del rol (`process.role_context`) es editable vía `PATCH /process` (UI en la Home) y se inyecta en los tres prompts del flujo (`summarize-cv`, `score-candidate`, `generate-questions`); el texto neutro cuando no hay contexto vive en `ai/role-context.ts`. Los prompts no exigen métricas ni impacto cuantificado (decisión del 2026-07-30, ver §13 del blueprint).
- `scoring/weights.ts` es la ÚNICA fuente de pesos (rúbrica y combinado 30/70) y desempates; el modelo nunca calcula el score final (el backend lo recalcula siempre) y el frontend consume los pesos vía `GET /ranking` (`weights` y `scoreWeights`).
- **Export** (§19) `apps/api/src/export/`: `POST /export` acepta `format: "markdown"` (default, contrato original) o `"structured"`. El markdown lo escribe `markdown-builder.ts`; el structured devuelve LOS MISMOS datos en JSON y `structured-builder.ts` solo aplica `include` (nada de duplicar la selección de datos). La UI maqueta ese JSON en `/export/print` y el **navegador** genera el PDF: cero librerías nuevas y la API sigue sin escribir en disco. La vista de impresión NUNCA convierte markdown a HTML —prohibidos `dangerouslySetInnerHTML`, `innerHTML` y cualquier librería markdown→HTML— porque el contenido viene del modelo y del CV. Los datos llegan a la vista **en memoria** (`apps/web/src/context/PrintExportContext.tsx`), nunca por sessionStorage ni por el state del router (§17), y la vista no vuelve a llamar a la API (consumiría otra de las 10 exportaciones).
- Límite de 5 regeneraciones de análisis = COUNT de `app_event` con `action='candidate.analyzed'` (solo éxitos); 20 preguntas = COUNT en tabla (`DELETE /candidates/:id/questions/:questionId` borra una SIN respuesta para hacer sitio); 10 exports/hora = ventana deslizante en memoria (`export-session.ts`; desde el 2026-08-15 "sesión" ya no es la vida del proceso).
- Errores: `AppError` con códigos tipados (`shared/errors.ts`) → `{error:{code,message}}`; los errores no controlados se loguean sin mensaje (solo tipo + frames).

## Entrevista asistida por audio (§24, 2026-08-07)

Subir la grabación de una entrevista → transcribir en local → **proponer** nota y notas para las preguntas sin puntuar, incluidas las que el candidato abordó sin que se le preguntara. Motivación: la nota de entrevista pesa el 70% del score final y las preguntas en blanco distorsionan el ranking.

- **Transcripción**: `ai/stt-client.ts` habla con `faster-whisper-server` (contenedor `voice-stt` de /opt/ai-server, perfil `voice`) en `STT_BASE_URL`. NO cuelga del router de :8080, que no enruta audio. Cola de concurrencia 1 y `STT_TIMEOUT_MS=600000` — no los 120 s del LLM: una pista de 50 min tarda ~4,5 min en CPU. `GET /health` reporta `stt`.
- **Dos pistas separadas, nunca mezcladas**: whisper no diariza. Con una sola pista el modelo no distingue lo que dijo el candidato de lo que preguntó el entrevistador, y ese falso positivo es irrecuperable. La atribución de hablante es un dato, no una instrucción del prompt.
- **Dos etapas** (`interview/analysis-runner.ts`): enrutado por fragmento (`map-transcript-topics`) y evaluación por pregunta (`assess-question-coverage`). Un 2B no mapea 20 preguntas contra 45.000 caracteres de una vez. Troceado con solape de 20 s en `interview/chunking.ts`; si el enrutado no asigna nada a una pregunta, `interview/lexical-match.ts` elige el mejor fragmento para que ninguna quede sin evaluar **en silencio**. `stats.routingFailures` hace visible cuándo pasa.
- **`interview/quote-verifier.ts` es la pieza crítica**: verifica cada cita contra lo que dijo el CANDIDATO, degrada `abordado_*` a `mencionado` si no queda evidencia, aplica suelos de longitud (180/60 caracteres) y anula la nota si el nivel final no la justifica. Cuatro capas en código, no en el prompt. **Quita el prefijo `[12:31] CANDIDATO:` de las citas**: el modelo copia la línea entera y sin eso NINGUNA cita casaba (verificado el 2026-08-07).
- **El sistema propone, el humano decide**: el dominio interview NUNCA escribe `answer_score`/`answer_notes`. Aplicar una propuesta es mandar el `PATCH .../answer` de siempre y después marcarla `applied`.
- **Job en memoria con COLA** (`interview/job-registry.ts`, 2026-08-15): uno corriendo, hasta 5 esperando (`MAX_QUEUED_INTERVIEW_ANALYSES`), un solo job vivo por candidato, con polling. Un job en cola no retiene audio en RAM (el runner lee el disco cuando le toca) y al arrancar relee grabación, preguntas y contexto. Sigue siendo volátil a propósito: lo que se recupera de un análisis caído no es el job, es la **grabación**; `RecordingDTO.lastStatus` se DERIVA cruzando la fila con el registro (`queued`/`running`/`interrupted`) y `activeJobId` permite a la UI reengancharse tras recargar. Rate limit en dos cupos: `INTERVIEW` (transcribe, 6/h) e `INTERVIEW_REANALYSIS` (desde `transcript.json`, 20/h); el cupo se devuelve (`RateLimiter.refund`) si se cancela en cola o cae con `STT_UNAVAILABLE`, nunca al cancelar uno que corre.
- **El audio y la transcripción SÍ se persisten** desde el 2026-08-10 (`interview/recording-store.ts` + migración 006), lo que **deroga** la regla de §17 que decía lo contrario. Motivo: cuando el job moría a medias se perdía también el audio —el navegador solo lo tenía en RAM— y una entrevista ya celebrada se quedaba sin evaluar. Ahora se reintenta con `POST .../analysis/from/:recordingId`, y si `transcript.json` existe el reintento **se salta whisper** (~4,5 min por pista). `interview/audio-upload.middleware.ts` sigue con `memoryStorage` y `takeAudioOwnership`; el buffer en RAM se sigue poniendo a cero al transcribir — lo que cambia es que antes de eso ya está en disco.
- **Reglas que sostienen esa decisión**: el audio NO se sirve por ninguna ruta (solo se reanaliza o se borra); la pantalla del candidato lista siempre lo guardado con su tamaño; purgar el proceso borra los **archivos antes que las filas** (el `ON DELETE CASCADE` se llevaría la única pista de qué hay en disco); al arrancar se barren las grabaciones huérfanas (`pruneOrphanRecordings`, solo directorios con nombre de UUID); tope de 5 por candidato que **rechaza** en vez de rotar; sin caducidad automática. Escritura atómica (`.tmp` + `rename`) porque el fallo del que venimos es un proceso que muere a medias.
- Reanalizar NO admite cambiar `candidateSource`: la transcripción ya está atribuida y darle la vuelta convertiría lo que preguntó el entrevistador en algo "demostrado" por el candidato.
- Validado contra el modelo real el 2026-08-07: 4/4 niveles de cobertura correctos, ~3-4 s por llamada.
- **Captura en el navegador** (`interview/useAudioCapture.ts`): micrófono + pestaña en dos `MediaRecorder` independientes. `getDisplayMedia` va con `video: true` OBLIGATORIO —Chrome no enseña la casilla del audio de pestaña en una petición solo-audio— y el vídeo se descarta al instante. El bucle de medidores usa una bandera además de `cancelAnimationFrame`: se reprograma a sí mismo y sin ella revivía tras el desmontaje. Exige contexto seguro; con el HTTPS del servidor de desarrollo eso ya se cumple también desde la LAN, y si aun así se entra por HTTP en claro la pantalla ofrece la dirección `https://` equivalente y el camino de subir el archivo.
- **Subir un archivo suelto es más débil que grabar**: una sola pista no permite separar hablantes, así que el modelo puede tomar por demostrado algo que preguntó el entrevistador. La UI lo advierte.
- **Calidad del STT**: `faster-whisper-base` degrada el español técnico de forma apreciable (medido: "throttles en CloudWatch" → "trotles en trogwatch"). `STT_MODEL=Systran/faster-whisper-small` lo mejora; es una variable más un pull al contenedor.

## Deuda técnica

Cifrado en reposo pendiente (§17) — obligatorio antes de usar datos reales. Ver README. Desde el 2026-08-10 la deuda **creció**: además de `data/local.db` (con las citas de entrevista, transcripción literal de una persona real) está `data/interviews/`, con **grabaciones completas de voz** de personas identificables. Sin cifrar, en una máquina cuya UI es accesible desde la LAN sin autenticación. `RECORDINGS_DIR` está separado de `DB_PATH` justamente para poder apuntarlo a un volumen cifrado sin mover la base. Conservar la grabación de una entrevista además obliga a informar al candidato.

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
- El borrado de todos los datos derivados de un proceso está disponible de forma explícita y con confirmación (`confirmDelete: true`). Desde el multiproceso, archivar ya NO borra: los datos de un proceso terminado persisten hasta que alguien los borre, lo que agrava la deuda del cifrado en reposo.

Si algo de esto no se puede cumplir en una iteración, debe quedar registrado como deuda técnica **antes** de usar datos reales (aplica especialmente al cifrado en reposo de resúmenes, evidencias, notas y resultados).

## Rúbrica y ranking

Cinco criterios, cada uno puntuado de 1 a 5. El modelo propone enteros y la
edición manual admite pasos de 0,5:

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
├── data/interviews/       # audio + transcripción por grabación (§24, sin cifrar)
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

Rutas previstas en §10 del blueprint; el flujo canónico es: crear proceso → añadir candidato → subir CV → `/cv/extract` → `/analyze` → `/questions` → editar `/score` → `/ranking` → `/export` → `/process/close` (archivar). En paralelo se puede abrir otro proceso (`POST /process`) y saltar entre ellos (`POST /process/:id/select`).

## Reglas de análisis con el modelo

El análisis debe **separar evidencia explícita de inferencia**. No inventar experiencia, no asumir dominio por la simple mención de una tecnología, distinguir exposición superficial de responsabilidad real, y marcar explícitamente qué queda pendiente de validar en entrevista. Cada análisis reporta un **nivel de confianza**.

Cada pregunta generada lleva el bloque de §14: pregunta, dimensión, criterio, respuesta ideal, señales positivas, señales de alerta y guía de puntuación.

**Generar preguntas no requiere análisis previo** (2026-08-07): el usecase solo exige `cv_summary`. Exigir análisis gastaba una de las 5 regeneraciones por candidato (§16) nada más que para poder preguntar. Si hay score, `{{analysis_json}}` lo lleva; si no, va el texto de `ai/analysis-context.ts` — una frase, no un `{}`, que el modelo leería como "analizado y sin hallazgos".

**Brevedad del bloque** (2026-08-07): se lee en voz alta en la entrevista. Quien marca la longitud es `prompts/generate-questions.md` (pregunta ~200 caracteres y UNA sola, respuesta ideal ~300, 3 señales de ~100, puntuación ~200); los `maxLength` de `ai/schemas/generate-questions.ts` son un techo con holgura deliberada, porque el schema se vuelve gramática en llama.cpp y un tope pegado al objetivo convertiría cualquier frase larga en un reintento. Medido contra `gemma-4-E2B`: la pregunta bajó de ~380 a ~120 caracteres. Se retiró el campo `validates` (repetía la pregunta): la columna y el DTO se conservan por las preguntas antiguas, pero ni se pide al modelo ni se pinta. `questions/trim-question.ts` recorta la segunda interrogación de cola que el modelo cuela pese al prompt — se normaliza en vez de rechazar porque rechazar dispararía reintentos y podría tirar la generación entera por una coletilla. El prompt también exige español explícitamente: sin esa regla, con un CV en inglés el modelo devolvía las preguntas en inglés.

## Límites operativos

CV ≤ 10 MB; texto extraído ≤ 50.000 caracteres; ≤ 100 candidatos por proceso; ≤ 5 regeneraciones de análisis por candidato; ≤ 20 preguntas por candidato; ≤ 10 exportaciones por hora (ventana deslizante); audio de entrevista ≤ 25 MB por pista, ≤ 5 grabaciones conservadas por candidato (§24: se rechaza al llegar al tope, no se rota — qué se borra lo decide el evaluador) y ≤ 5 análisis de entrevista esperando en cola. Rate limiting local por hora: extracción 20, análisis 30, preguntas 60, ranking 30, entrevista 6 (transcribe) y reanálisis desde transcripción 20. Formatos aceptados: PDF, DOCX, TXT.

## Fuera de alcance del MVP

Login real, registro público, múltiples usuarios, roles complejos, modelos externos, ATS, emails, calendario, pagos y decisión automática de contratación. Sigue habiendo un único proceso *seleccionado* a la vez y un único rol técnico por proceso; lo que ya no aplica es el límite de un solo proceso abierto.

## Idioma

Documentación, prompts y comunicación en español. Identificadores de código en inglés (coherente con los nombres de campo del modelo de datos).
