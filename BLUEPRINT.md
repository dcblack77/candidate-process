# BLUEPRINT.md

Quiero construir un sistema local para cargar nombres y CVs de candidatos, resumirlos, compararlos con una rúbrica ponderada y generar preguntas de entrevista con respuestas ideales para saber qué puntuar y cómo. Es para mí, con opción de mostrar resultados a mi líder, y va a manejar nombres de candidatos, resúmenes de CVs, evidencias profesionales, puntuaciones, preguntas, respuestas ideales y notas de evaluación.

## 01. Objetivo

Crear una herramienta local para comparar candidatos de un único rol técnico, usando criterios ponderados y análisis asistido por un modelo local `Gemma4-e2b`.

El sistema debe ayudar a decidir mejor, pero no debe tomar decisiones automáticas de contratación. Su función es organizar evidencia, proponer puntuaciones, generar preguntas de entrevista y mostrar un ranking justificable.

## 02. Usuarios

El sistema tendrá un único usuario inicial: `Admin`.

Admin puede crear procesos, cargar CVs, analizar candidatos, editar puntuaciones, generar preguntas, ver rankings, exportar resultados para su líder y borrar los datos al cerrar el proceso.

## 03. Contexto De Uso

La aplicación correrá en local.

No tendrá registro público, usuarios múltiples ni exposición a internet en la primera versión.

La seguridad se diseñará desde el inicio como estructura interna, aunque la autenticación real se agregue después si hace falta.

## 04. Datos Que Maneja

El sistema manejará datos personales de candidatos, por lo que debe tratarse como información sensible.

Datos permitidos:

- Nombre del candidato.
- Resumen estructurado del CV.
- Evidencias profesionales relevantes.
- Puntuaciones por criterio.
- Preguntas de entrevista.
- Respuestas ideales.
- Señales positivas y señales de alerta.
- Notas privadas del evaluador.
- Ranking final.

Datos que no deben persistirse:

- CV original.
- Archivo PDF, DOCX o TXT después del procesamiento.
- Texto completo del CV si no es necesario.
- Fotos.
- Edad.
- Dirección.
- Nacionalidad.
- Estado civil.
- Datos personales irrelevantes para la evaluación técnica.

## 05. Alcance Inicial

Incluido:

- App local.
- Un único usuario Admin.
- Carga de nombres y CVs.
- Extracción de texto del CV.
- Resumen estructurado del CV.
- Eliminación del archivo original tras extraer/resumir.
- Análisis con `Gemma4-e2b` local.
- Ranking ponderado.
- Generación de preguntas de entrevista.
- Generación de respuestas ideales.
- Edición manual de puntuaciones.
- Exportación limitada para compartir con el líder.
- Borrado de datos al terminar el proceso.

No incluido:

- Login real en MVP.
- Registro público.
- Múltiples usuarios.
- Roles complejos.
- Modelos externos.
- ATS.
- Emails automáticos.
- Calendario.
- Pagos.
- Decisión automática de contratación.

## 06. Criterios De Puntuación

Los criterios que pesan en el ranking son:

| Criterio | Peso | Definición |
|---|---:|---|
| Adaptabilidad | 30% | Transiciones tecnológicas demostradas, no supuestas |
| Fundamentos | 25% | Conocimiento transferible, no atado a herramientas |
| Profundidad | 20% | Resultados reales en cada entorno, no solo exposición |
| Producción | 15% | Debugging, operación y responsabilidad sobre sistemas vivos |
| Stack | 10% | Cercanía con AWS, TypeScript y serverless como acelerador, no requisito |

Cada criterio se puntúa de 1 a 5. El análisis automático propone enteros; la
revisión humana puede ajustar en pasos de 0,5.

La puntuación tiene **dos niveles**: la rúbrica produce el *score de CV* y
encima se calcula el *score final combinado* con la entrevista.

### Nivel 1: score de CV (rúbrica)

```text
score_cv =
  adaptabilidad * 0.30 +
  fundamentos * 0.25 +
  profundidad * 0.20 +
  produccion * 0.15 +
  stack * 0.10
```

Es lo que **promete** el CV. Es el valor que se persiste en
`candidate_score.final_score` y el que edita manualmente el evaluador.

### Nivel 2: score final combinado (CV + entrevista)

```text
score_final = score_cv * 0.30 + (nota_entrevista / 2) * 0.70
```

Es lo que el candidato ha **demostrado**. `nota_entrevista` es la nota global
de entrevista (1-10, §15) y se divide por 2 para llevarla a la escala 1-5 de
la rúbrica, de modo que ambos sumandos son comparables. El resultado se
redondea a 2 decimales y **no se persiste**: es derivado, se recalcula en
cada lectura.

La entrevista pesa más que el CV a propósito: el CV es una promesa
autoinformada; la entrevista es evidencia observada por el evaluador.

Un candidato **sin ninguna respuesta de entrevista puntuada** no se penaliza:
su score final es su score de CV, pero se marca como **provisional** para que
quede claro que aún no está contrastado.

Los pesos (`0.30` / `0.70`), el divisor de escala y la fórmula viven en un
único sitio del código (`scoring/weights.ts`) y se exponen en `GET /ranking`
como `scoreWeights`.

## 07. Lo Que Se Valida En Entrevista

El sistema debe generar preguntas para validar lo que el CV no confirma.

| Dimensión | Qué valida |
|---|---|
| Velocidad | Cuánto tarda realmente en adaptarse |
| Profundidad vs. exposición | Si domina o solo tocó la tecnología |
| Contribución | Qué entregó después de cada transición |
| Aprendizaje | Su método personal para aprender |
| Investigación | Cómo ataca problemas en sistemas que no conoce |
| Operación | Experiencia real llevando cosas a producción |

Cada pregunta debe incluir:

```text
Pregunta
Dimensión evaluada
Criterio relacionado
Respuesta ideal
Señales positivas
Señales de alerta
Guía de puntuación
```

"Qué busca validar" se retiró el 2026-08-07 por redundante (ver §14).

## 08. Autenticación Y Registro

En la primera versión no habrá registro ni login real porque la aplicación será local y usada solo por Admin.

Aun así, la estructura debe quedar preparada desde el inicio para añadir seguridad después sin reescribir el sistema.

Decisión MVP:

- Usuario único: `Admin`.
- Sin registro público.
- Sin usuarios múltiples.
- Sin login obligatorio.
- App accesible solo en local.
- API escuchando solo en `localhost`.
- Ninguna ruta expuesta a internet.

Diseño obligatorio desde el inicio:

```text
currentUser = {
  id: "local-admin",
  role: "admin"
}
```

Toda acción debe recibir o resolver `currentUser`, aunque en MVP siempre sea Admin.

Esto permite agregar después:

- Login con contraseña local.
- Sesiones.
- Usuarios múltiples.
- Roles.
- Permisos por proceso.
- SSO corporativo si algún día se necesita.

Si se agrega registro más adelante:

- Debe ser por invitación.
- No debe existir registro abierto.
- El primer usuario debe ser Admin.
- Solo Admin puede crear otros usuarios.

## 09. Permisos Y Roles

Rol inicial:

| Rol | Permisos |
|---|---|
| Admin | Acceso completo al sistema local |

Aunque solo exista Admin, el backend debe tener una capa de permisos.

Funciones esperadas:

```text
canCreateProcess(user)
canCreateCandidate(user)
canUploadCV(user)
canAnalyzeCandidate(user)
canGenerateQuestions(user)
canEditScores(user)
canViewRanking(user)
canExportResults(user)
canCloseProcess(user)
canDeleteData(user)
```

En MVP todas devuelven `true` para Admin.

Regla importante: los permisos deben validarse en backend, no depender solo de botones ocultos en la interfaz.

## 10. Protección De Endpoints Y Rutas De API

La API debe tratar todos los datos como privados.

Rutas previstas:

```text
GET    /health

GET    /process              # el proceso SELECCIONADO (404 si no hay)
GET    /process/list         # todos los procesos, abiertos y archivados
POST   /process              # crea uno nuevo y lo deja seleccionado
PATCH  /process
POST   /process/:id/select   # cambia el proceso seleccionado
POST   /process/close        # ARCHIVA el seleccionado (no borra)
POST   /process/:id/reopen   # devuelve un archivado a escritura
DELETE /process              # borra el seleccionado (confirmDelete)
DELETE /process/:id          # borra uno concreto (confirmDelete)

GET    /candidates
POST   /candidates
GET    /candidates/:id
PATCH  /candidates/:id
DELETE /candidates/:id

POST   /candidates/:id/cv/extract
POST   /candidates/:id/analyze
POST   /candidates/:id/risks     # riesgos y lagunas para la entrevista (§13)
GET    /candidates/:id/risks
POST   /candidates/:id/questions
PATCH  /candidates/:id/questions/:questionId/answer
PATCH  /candidates/:id/score
POST   /candidates/:id/notes

GET    /ranking
POST   /export
```

Protecciones requeridas:

- La API solo acepta conexiones desde `localhost`.
- Cada ruta resuelve `currentUser`.
- Cada ruta valida permisos.
- Cada ID recibido se valida.
- No se devuelve contenido sensible en errores.
- No se guardan CVs originales.
- No se sirven archivos subidos desde rutas públicas.
- Los exports excluyen datos innecesarios por defecto.

### Transporte de la UI

La API sigue atada a `127.0.0.1`. La **UI** se expone a la LAN por decisión
explícita del usuario (2026-07-29) y desde el 2026-08-08 se sirve por **HTTPS
con un certificado autofirmado** que se genera solo en `certs/`
(`apps/web/dev/tls.ts`).

El certificado **no aporta seguridad**: sigue sin haber autenticación (§08) y
la protección real es la red de confianza. Existe por una razón mecánica: el
navegador no da acceso al micrófono fuera de un contexto seguro, así que sin
TLS grabar la entrevista (§24) era imposible desde cualquier equipo que no
fuera el servidor. La alternativa —quitar la comprobación— no existe: la
restricción es del navegador, no de la aplicación.

Detalles que importan:

- Los SAN cubren `localhost`, el nombre de red de la máquina y todas sus IPv4
  no internas. Si el DHCP cambia la IP, el certificado deja de valer y se
  regenera solo en el siguiente arranque.
- El certificado persiste en disco a propósito: cada dispositivo acepta la
  excepción una vez y no vuelve a preguntar. Regenerarlo la invalida, por eso
  solo se hace cuando de verdad ha dejado de servir.
- La clave privada se escribe con permisos `0600` y `certs/` está en
  `.gitignore`.
- `WEB_HTTPS=false` vuelve a HTTP en claro. Si la generación falla, la UI
  arranca igualmente en HTTP con un aviso: mejor sin grabación que sin app.

## 11. Flujo Principal

1. Admin abre la app local.
2. Crea un proceso para un único rol.
3. Añade candidatos por nombre.
4. Carga un CV por candidato.
5. El sistema extrae texto.
6. El sistema genera un resumen estructurado.
7. El CV original se borra.
8. El sistema analiza el resumen con `Gemma4-e2b`.
9. El sistema propone puntuaciones y evidencias.
10. El sistema genera preguntas de entrevista.
11. Admin revisa y edita puntuaciones.
12. El sistema calcula ranking.
13. Admin exporta una versión compartible para su líder.
14. Admin archiva el proceso; el borrado de los datos es una acción aparte.

Los pasos 8 y 9 **no son requisito del 10**: desde el 2026-08-07 se pueden
generar preguntas en cuanto hay resumen de CV (paso 6), sin analizar. Analizar
solo para poder preguntar gastaba una de las 5 regeneraciones de análisis por
candidato (§16). Si el análisis existe, sus dudas y sus criterios flojos son la
primera fuente de preguntas; si no, el prompt trabaja con el CV y el contexto
del rol.

## 12. Modelo De Datos

### Process

```text
id
role_title
role_context
status        # 'active' (abierto) | 'closed' (archivado, solo lectura)
created_at
closed_at
is_current    # 1 en el proceso seleccionado, 0 en el resto (único)
```

Puede haber varios procesos con `status='active'` a la vez. Lo que es único
es `is_current`: el proceso sobre el que operan candidatos, análisis, ranking
y export. Es estado de **servidor**, compartido por todos los clientes.

### Candidate

```text
id
process_id
name
cv_summary
cv_evidence
analysis_status
created_at
updated_at
deleted_at
```

### CandidateScore

```text
id
candidate_id
adaptability
fundamentals
depth
production
stack
final_score
confidence
evidence_summary
manual_notes
created_at
updated_at
```

`final_score` es el **score de CV** de la rúbrica (§06, nivel 1). El score
final combinado con la entrevista es derivado y NO se persiste. En
`evidence_summary` se guarda, por criterio, `{rationale, evidence, verdict}`
(el `verdict` es el contraste con la entrevista, §13; los análisis anteriores
a esa versión no lo tienen y el código lo trata como ausente).

### InterviewQuestion

```text
id
candidate_id
criterion
dimension
question
validates
ideal_answer
positive_signals
warning_signals
scoring_guidance
created_at
answer_score    # nota de la respuesta del candidato, entero 1-10 (null si no se puntuó)
answer_notes    # notas privadas de lo que respondió (dato sensible: fuera del export por defecto)
answered_at     # ISO 8601 UTC del último registro de respuesta (null si no hay respuesta)
```

### CandidateRiskAnalysis

```text
id
candidate_id    # UNIQUE: una fila por candidato, regenerar sobrescribe
confidence
risks           # JSON [{category, criterion, severity, concern, evidence{text,type}, interviewCheck}]
gaps            # JSON [{criterion, missing, whyItMatters, interviewCheck}]
stats           # JSON con los contadores del verificador (explicit/inferred/rebajados)
created_at
updated_at
```

### AppEvent

```text
id
action
entity_type
entity_id
metadata
created_at
```

## 13. Análisis De CV

El análisis debe separar evidencia explícita de inferencias.

Salida esperada por candidato:

```text
Resumen profesional
Evidencias de adaptabilidad
Evidencias de fundamentos
Evidencias de profundidad
Evidencias de producción
Evidencias de stack
Dudas para entrevista
Riesgos
Puntuación sugerida
Nivel de confianza
```

Reglas:

- No inventar experiencia.
- No asumir dominio por simple mención de una tecnología.
- Diferenciar exposición superficial de responsabilidad real.
- Priorizar resultados concretos (entregables, sistemas en producción,
  responsabilidad real). No se exigen métricas ni impacto cuantificado: ese
  dato lo mide un equipo distinto al de desarrollo y el candidato no suele
  conocerlo, así que su ausencia no penaliza.
- Detectar transiciones tecnológicas demostradas.
- Señalar qué debe validarse en entrevista.
- Ignorar datos personales irrelevantes.

### Contraste con la entrevista

Si el candidato ya tiene respuestas de entrevista puntuadas, el análisis
**no puede volver a mirar solo el CV**: recibe también esa evidencia (por
pregunta respondida: criterio, enunciado, respuesta ideal, nota 1-10 y notas
del evaluador) y debe **contrastar** lo que el CV promete con lo que se
demostró.

- Nota media del criterio ≥ 8 ⇒ confirma: mantener o subir.
- Nota media entre 5 y 7 ⇒ demostración parcial: bajar si el CV prometía 4-5.
- Nota media ≤ 4 ⇒ **bajar** el criterio: lo que el CV prometía no se
  demostró.
- Notas que contradicen directamente el CV ⇒ bajar a 1 o 2.
- Criterio sin respuestas puntuadas ⇒ se puntúa solo con el CV.

Cada criterio del análisis reporta un **veredicto** del contraste:

| Veredicto | Significado |
|---|---|
| `confirmed` | La entrevista confirma lo que prometía el CV. |
| `not_demonstrated` | El CV lo prometía y la entrevista no lo demostró. |
| `contradicted` | La entrevista contradice lo que el CV afirmaba. |
| `not_assessed` | No hubo respuestas puntuadas de ese criterio. |

El veredicto se persiste junto al `rationale` y las evidencias, y sale en el
detalle del candidato y en la exportación. Sin respuestas puntuadas el
análisis se comporta exactamente igual que antes del contraste y todos los
veredictos son `not_assessed`.

El contexto de entrevista se trunca para no romper el presupuesto de tokens
(§18): notas del evaluador a 400 caracteres por pregunta, respuesta ideal y
enunciado a 300.

### Riesgos y lagunas (2026-08-15)

`POST /candidates/:id/risks` (dominio `risks/`, prompt
`detect-risks-and-gaps`) es una pasada específica sobre el `cv_summary`,
independiente de la puntuación: señala qué **no se puede saber** a partir del
CV (lagunas) y dónde están los **riesgos** de contratar, cada uno con qué
preguntar en la entrevista para despejarlo. Es material para la entrevista,
no una conclusión: no toca `candidate_score` ni el ranking.

- Solo exige `cv_summary` (no análisis previo); recibe título y contexto del
  rol. Máximo 5 detecciones por candidato (eventos `candidate.risks_detected`)
  y 30/hora.
- Riesgo ≠ laguna: el riesgo se apoya en algo que el resumen **sí dice**
  (`evidence {text, type}`); la laguna es lo que el resumen **no** permite
  saber y no lleva evidencia ni severidad.
- **Verificación en código** (`risks/risk-verifier.ts`): toda evidencia
  `explicit` se comprueba contra el resumen y el contexto del rol; si no se
  sostiene se rebaja a `inferred` antes de persistir. Un riesgo inventado es
  peor que no reportarlo. `stats.downgradedToInferred` deja visible cuántas
  veces pasó.
- Una fila por candidato (`candidate_risk_analysis`, migración 007);
  regenerar sobrescribe. `GET` responde `analysis: null` si aún no hay.

## 14. Generación De Preguntas

**El análisis previo NO es requisito** (2026-08-07): basta con que el CV esté
procesado. Ver §11.

Cada candidato debe recibir preguntas personalizadas según:

- Brechas del CV.
- Transiciones tecnológicas.
- Experiencia real en producción.
- Profundidad técnica declarada.
- Cercanía con AWS, TypeScript y serverless.
- Dudas del análisis.

Formato de pregunta:

```text
Pregunta:
Dimensión:
Criterio:
Respuesta ideal:
Señales positivas:
Señales de alerta:
Cómo puntuar:
```

El campo **Qué valida** se retiró el 2026-08-07: repetía lo que ya dicen la
pregunta, el criterio y la dimensión. La columna `interview_question.validates`
se conserva con el texto de las preguntas generadas antes, pero ni se pide al
modelo ni se muestra.

**Brevedad (2026-08-07)**: el bloque se lee en voz alta durante la entrevista,
así que prima que se entienda de un vistazo. Objetivos de longitud, marcados
por el prompt (el JSON Schema pone un techo con holgura para no disparar
reintentos): pregunta ~200 caracteres y **una sola** —nada de encadenar
sub-preguntas—, respuesta ideal ~300 en 2-3 frases, **3** señales de cada tipo
de una línea (~100), y cómo puntuar ~200 en total con una frase por nivel.

Ejemplo:

```text
Pregunta:
Migraste el legacy a microservicios. ¿Cuál fue la decisión de diseño más difícil y por qué la tomaste así?

Dimensión:
profundidad_vs_exposicion

Criterio:
depth

Respuesta ideal:
Nombra una decisión concreta (cómo partir el dominio, dónde poner la frontera). Explica la alternativa que descartó y por qué. Menciona cómo comprobó que funcionó.

Señales positivas:
Compara al menos dos alternativas reales. · Cita una métrica concreta. · Reconoce lo que salió mal.

Señales de alerta:
Describe la migración sin ninguna decisión. · Justifica por moda, no por contexto. · No sabe si mejoró algo.

Cómo puntuar:
1: sin decisión propia. 3: decisión sin alternativas ni datos. 5: decisión, trade-off y validación.
```

## 15. Ranking

El ranking se ordena por el **score final combinado** (§06) y debe mostrar:

- Posición.
- Nombre del candidato.
- Score de CV (rúbrica).
- Nota de entrevista (global y por criterio).
- Score final combinado, y si es **provisional**.
- Score por criterio.
- Evidencia resumida.
- Confianza del análisis.
- Dudas pendientes.
- Preguntas clave.

Un score final es **provisional** cuando el candidato todavía no tiene
ninguna respuesta de entrevista puntuada: vale su score de CV (no se le
penaliza) pero no está contrastado y se mueve en cuanto se le puntúe la
entrevista.

Reglas de desempate (sobre el score final combinado):

1. Mayor adaptabilidad.
2. Mayor fundamentos.
3. Mayor producción.
4. Mayor profundidad.
5. Mayor stack.
6. Mayor nota de entrevista.
7. Mayor confianza.
8. Revisión manual.

Nota de entrevista: media de las notas (1-10) de las respuestas de cada
criterio, agregadas con los pesos de §06 renormalizados sobre los criterios
que tengan al menos una respuesta puntuada.

Esa nota entra en el score final combinado con peso 70% (§06) y, además,
sigue siendo un nivel de desempate: ahí un candidato sin ninguna respuesta
puntuada cuenta como 0 (ante dos scores combinados iguales gana quien tiene
evidencia observada). La nota de entrevista **no** altera el score de CV: la
rúbrica de §06 se calcula solo con los cinco criterios.

## 16. Restricciones, Reglas Y Límites De Uso

Restricciones:

- Varios procesos abiertos a la vez; **uno solo seleccionado** (decisión del
  2026-08-07, deroga el "solo un proceso activo en MVP" original). Abrir un
  proceso nuevo no cierra ni borra los anteriores.
- La selección es **estado de servidor compartido**: cambiar de proceso desde
  un equipo lo cambia para todos los que estén usando la aplicación.
- Un proceso archivado (`status='closed'`) es de **solo lectura**: se
  consulta y se exporta, pero toda escritura se rechaza con `PROCESS_CLOSED`.
- Solo usuario Admin.
- Solo rol objetivo único.
- No se guardan CVs originales.
- No se usan proveedores externos de IA.
- No se expone la API fuera de local.
- No se aceptan archivos fuera de los formatos permitidos.
- No se muestran notas privadas completas en exports por defecto.
- Al archivar el proceso debe existir opción clara de borrado definitivo,
  separada y con confirmación explícita.

Formatos permitidos:

```text
PDF
DOCX
TXT
```

Límites recomendados:

| Acción | Límite |
|---|---:|
| Tamaño máximo por CV | 10 MB |
| Texto máximo extraído por CV | 50.000 caracteres |
| Candidatos por proceso | 100 |
| Regeneraciones de análisis por candidato | 5 |
| Preguntas por candidato | 20 |
| Exportaciones por sesión | 10 |
| Tamaño máximo por pista de audio | 25 MB |
| Caracteres de transcripción por entrevista | 120.000 (~2 h) |
| Citas persistidas por propuesta | 3 de 300 caracteres |

Rate limiting local:

| Acción | Límite |
|---|---:|
| Extracción de CV | 20 por hora |
| Análisis con Gemma4-e2b | 30 por hora |
| Generación de preguntas | 60 por hora |
| Regeneración de ranking | 30 por hora |
| Análisis de audio de entrevista | 6 por hora |

Aunque sea local, estos límites evitan bloqueos, abuso accidental y consumo excesivo del modelo.

## 17. Manejo De Datos Sensibles

Qué se guarda:

- Nombre.
- Resumen del CV.
- Evidencias relevantes.
- Puntuaciones.
- Preguntas.
- Respuestas ideales.
- Notas propias.
- Ranking.

Qué no se guarda:

- CV original.
- Archivo subido.
- Texto completo del CV si no es necesario.
- Datos personales irrelevantes.
- Prompts completos con información sensible.
- Logs con contenido del CV.

Qué se cifra:

- Base de datos local, si es razonable para el MVP.
- Resúmenes de CV.
- Evidencias.
- Notas.
- Resultados de análisis.

Si el cifrado no entra en la primera versión, debe quedar marcado como deuda técnica antes de usar datos reales.

Qué no se expone:

- CVs originales.
- Resúmenes completos en logs.
- Notas privadas en exportaciones por defecto.
- Datos personales innecesarios al líder.
- Errores técnicos con contenido sensible.

Borrado:

- Archivar un proceso (`status='closed'`) **no borra nada**: lo deja en solo
  lectura y sus datos siguen en `data/local.db` (decisión del 2026-08-07).
- El borrado de candidatos, resúmenes, evidencias, puntuaciones, preguntas,
  notas y ranking es una acción **aparte**, disponible en cualquier momento
  sobre cualquier proceso.
- El borrado definitivo debe pedir confirmación.
- No debe quedar copia del CV original.

El **audio de entrevista y su transcripción SÍ se persisten** desde el
2026-08-10, en `RECORDINGS_DIR` (por defecto `data/interviews/<id>/`). Esto
**deroga** la regla anterior, que decía que ni uno ni otra tocaban el disco.

Motivo del cambio: el análisis vive en un job en memoria y cuando moría a
medias —reinicio del backend, timeout, cancelación accidental— se perdía el
trabajo Y el audio, porque el navegador tampoco lo conservaba. El resultado
era una entrevista que ya había ocurrido y que no se podía volver a evaluar
sin repetirla. Persistir convierte ese fallo irrecuperable en un reintento
(`POST /candidates/:id/interview/analysis/from/:recordingId`), y persistir
además la transcripción hace que el reintento no repita los ~4,5 minutos de
whisper por pista.

Lo que esto obliga a mantener:

- **Nunca se sirve el audio.** No hay ninguna ruta que lo devuelva; se
  reanaliza o se borra, igual que el CV original nunca se descarga.
- **Visible y borrable siempre.** La pantalla del candidato lista lo guardado
  con su tamaño, y `DELETE .../recordings/:id` borra archivos y fila. Purgar
  el proceso borra los archivos ANTES que las filas, porque el `ON DELETE
  CASCADE` se llevaría por delante la única pista de qué hay en disco.
- **Barrido de huérfanas al arrancar**: los directorios sin fila que los
  respalde se borran. Audio que la aplicación no sabe que existe es audio que
  nadie puede borrar desde la aplicación.
- **Tope de 5 grabaciones por candidato**, que se rechaza en vez de rotar: qué
  se borra lo decide el evaluador.
- **Sin caducidad automática** (decisión explícita): una grabación vive hasta
  que alguien la borra.

Las **citas** de las propuestas (`interview_answer_proposal.evidence`) siguen
guardándose en la base, acotadas a 3 de 300 caracteres, para que el evaluador
pueda auditar de dónde salió cada nota sugerida. Son dato PRIVADO al mismo
nivel que `answer_notes` y quedan fuera de los exports.

Consecuencia sobre el cifrado en reposo: la deuda **crece** con este cambio.
Antes lo peor que había en disco eran citas de 300 caracteres; ahora hay
grabaciones completas de voz de personas identificables, sin cifrar, en una
máquina cuya UI es accesible desde la LAN sin autenticación. Conservar
grabaciones de una entrevista también obliga a informar al candidato.

Consecuencia de archivar sobre el cifrado en reposo: antes, cerrar un proceso
purgaba sus datos y la ventana de exposición terminaba ahí. Ahora los datos de
un proceso terminado **persisten hasta que alguien los borre a mano**, así que
la deuda del cifrado en reposo pesa más que antes y hay que resolverla antes
de acumular procesos con datos reales.

## 18. Integración Con Gemma4-e2b

El sistema debe conectarse a un modelo local `Gemma4-e2b`.

Reglas:

- No enviar datos a servicios externos.
- Procesar localmente.
- Enviar solo el texto necesario.
- Evitar datos personales irrelevantes en prompts.
- Versionar prompts dentro del proyecto.
- Guardar solo respuestas estructuradas necesarias.

Prompts necesarios:

```text
summarize-cv.md
score-candidate.md
generate-questions.md
compare-candidates.md
detect-risks-and-gaps.md
```

## 19. Exportación Para El Líder

La exportación debe ser limpia y limitada.

Incluye:

- Ranking, con columnas **CV**, **Entrevista** y **Score final** (combinado),
  la nota de los pesos 30/70 y una marca `*` en los scores provisionales.
- Nombre del candidato.
- Score por criterio, con el **veredicto** del contraste con la entrevista
  (✓ confirmado / ⚠ no demostrado / ⚠ contradicho / — sin evaluar).
- Resumen breve.
- Fortalezas.
- Riesgos.
- Preguntas recomendadas.
- Nota de entrevista (global, por criterio y por pregunta): es puntuación, no
  texto sensible.

No incluye por defecto:

- CV original.
- Texto completo extraído.
- Notas privadas completas (incluido el texto de las respuestas de entrevista).
- Datos personales irrelevantes.
- Prompts.
- Información sensible innecesaria.

Formato recomendado:

```text
Markdown primero
PDF después
```

Ambos están implementados. `POST /export` acepta `format`:

- `format: "markdown"` (**default**, contrato original): devuelve el documento
  markdown ya escrito, para vista previa y descarga.
- `format: "structured"`: devuelve los MISMOS datos en JSON
  (`{ filename, generatedAt, roleTitle, roleContext, weights, scoreWeights,
  entries, unscored, include, ... }`) y la UI los maqueta en la ruta
  `/export/print`. El PDF lo genera el **navegador** ("Imprimir → Guardar como
  PDF", `@page { size: A4 }`): sin librerías de PDF y sin que la API escriba en
  disco. El `filename` sugerido lleva extensión `.pdf`.

Reglas comunes a los dos formatos: mismas banderas de `include` con los mismos
defaults seguros, mismo consumo del límite de 10 exportaciones por sesión
(§16) y misma auditoría (`export.generated` con el formato usado y
`export.included_sensitive` si se piden notas privadas).

**Seguridad de la vista de impresión**: el documento se renderiza SIEMPRE con
React desde los datos estructurados (escapado automático). Está prohibido
convertir el markdown a HTML (`dangerouslySetInnerHTML`, `innerHTML` o
cualquier librería markdown→HTML): el contenido viene del modelo y del CV y
podría traer enlaces o imágenes de exfiltración.

La vista de impresión añade sobre el markdown una **portada** (rol, contexto,
fecha, nº de candidatos, aviso de confidencialidad y, si procede, aviso de
información privada) y las **dudas pendientes** de cada candidato, que viajan
bajo la misma bandera `include.risks`. Los datos llegan a `/export/print`
**en memoria** desde la pantalla Exportar: no se guardan en `sessionStorage`
ni en el estado del router (§17) y la vista NUNCA vuelve a llamar a la API
(consumiría otra exportación).

## 20. Estructura Técnica Recomendada

```text
/
├── BLUEPRINT.md
├── README.md
├── data/
│   └── local.db
├── prompts/
│   ├── summarize-cv.md
│   ├── score-candidate.md
│   ├── generate-questions.md
│   ├── compare-candidates.md
│   └── detect-risks-and-gaps.md
└── src/
    ├── app/
    ├── ai/
    ├── candidates/
    ├── cv/
    ├── export/
    ├── questions/
    ├── ranking/
    ├── scoring/
    ├── security/
    └── shared/
```

## 21. Pantallas

### Inicio

- Ver el proceso en curso (o el aviso de solo lectura si está archivado).
- Crear proceso / abrir otro sin cerrar el anterior.
- Ver los demás procesos y cambiar de uno a otro.
- Reabrir un proceso archivado.
- Continuar análisis.
- Archivar o borrar el proceso.

### Candidatos

- Lista de candidatos.
- Añadir candidato.
- Cargar CV.
- Ver estado de análisis.

### Detalle De Candidato

- Grabar o subir el audio de la entrevista y ver el progreso del análisis.
- Revisar la propuesta de cada pregunta con sus citas y aplicarla o
  descartarla.

- Resumen.
- Evidencias.
- Puntuaciones.
- Preguntas.
- Notas.

### Comparativa

- Tabla por criterios.
- Score final.
- Evidencias.
- Dudas.
- Ranking.

### Exportar

- Vista previa.
- Selección de información.
- Exportación para líder.
- Descarga en Markdown o vista de impresión A4 (`/export/print`) para guardar
  en PDF desde el navegador.

### Archivar O Borrar

- Archivar: pasa a solo lectura conservando los datos. Sin confirmación —
  es reversible desde Inicio (Reabrir).
- Exportar antes de borrar.
- Borrar definitivamente: doble confirmación en UI (checkbox + escribir el
  nombre del rol) más `confirmDelete: true` en el backend.

## 22. Criterios De Aceptación

La primera versión está lista cuando:

- Puedo crear un proceso para un único rol.
- Puedo añadir candidatos.
- Puedo cargar CVs.
- El sistema extrae texto.
- El sistema genera un resumen.
- El CV original se elimina.
- El sistema analiza con `Gemma4-e2b` local.
- El sistema puntúa según los cinco criterios.
- El sistema muestra evidencia por puntuación.
- El sistema genera preguntas con respuestas ideales.
- Puedo editar puntuaciones manualmente.
- Puedo ver ranking.
- Puedo exportar una versión compartible con mi líder.
- Puedo cerrar el proceso.
- Puedo borrar los datos al finalizar.
- Las rutas pasan por una capa de permisos.
- Los datos sensibles no aparecen en logs ni exports por defecto.

## 23. Decisiones Cerradas

- Uso inicial: local.
- Usuario inicial: solo Admin.
- Autenticación real: no en MVP.
- Seguridad: estructura preparada desde el inicio.
- IA: solo local con `Gemma4-e2b`.
- CV original: no se conserva.
- Datos: se conservan al archivar el proceso y se borran con una acción
  explícita y confirmada (decisión del 2026-08-07; antes el cierre purgaba).
- Procesos: varios abiertos a la vez, uno seleccionado. Cada uno es un único
  rol técnico y sus datos son independientes.
- Visibilidad: notas y puntuaciones privadas para mí.
- Exportación: versión limitada para mostrar al líder.
- PDF: vía vista de impresión del navegador (decisión de 2026-07-29). Cero
  dependencias nuevas, la API no escribe en disco y el documento se renderiza
  desde datos estructurados, nunca convirtiendo markdown a HTML.
- Score final: combinado 30% CV / 70% entrevista (§06). Sin entrevista
  puntuada el score es el del CV y se marca como provisional.
- Análisis: contrasta el CV con la entrevista y baja los criterios que no se
  demostraron (§13).

## 24. Entrevista Asistida: Audio, Transcripción Y Propuestas

Decisión del 2026-08-07. Problema que resuelve: hoy solo se puede puntuar una
pregunta que se haya formulado, pero en entrevistas reales el candidato aborda
temas sin que se le pregunte. Como la nota de entrevista pesa el 70% del score
final (§06), esas preguntas en blanco distorsionan el ranking.

Flujo: se sube la grabación → se transcribe en local → el sistema detecta qué
preguntas quedaron cubiertas y **propone** nota (1-10), notas y citas. El
evaluador revisa y aplica. **Nada se aplica solo.**

### Infraestructura

`faster-whisper-server` local (contenedor `voice-stt` del stack de
/opt/ai-server, perfil `voice`), API compatible con OpenAI en
`STT_BASE_URL`. NO cuelga del router de :8080, que no enruta audio. Acepta
WebM/Opus del navegador sin conversión. `GET /health` reporta `stt`.

### Dos pistas, no una mezclada

El micrófono y el audio de la videollamada se graban y transcriben **por
separado**, y se fusionan por marca de tiempo etiquetando `CANDIDATO` / `SALA`.
whisper no diariza: mezclarlos haría imposible distinguir "el candidato
explicó cómo particionó el dominio" de "el entrevistador preguntó cómo lo
particionó", que es el falso positivo a evitar y es irrecuperable aguas abajo.

### Dos etapas de mapeo

`gemma-4-E2B` (2B) no mapea 8-20 preguntas contra 45.000 caracteres de una
tacada. Se parte en:

1. **Enrutado** (`prompts/map-transcript-topics.md`), una llamada por
   fragmento: qué temas de la lista salen en ESTE fragmento.
2. **Evaluación** (`prompts/assess-question-coverage.md`), una llamada por
   pregunta sin puntuar: cobertura, nota propuesta y citas.

Troceado con solape de 20 s y sin partir nunca un segmento de whisper. Si el
enrutado no asigna nada a una pregunta, entra un **respaldo léxico** para que
ninguna quede sin evaluar en silencio.

### Niveles de cobertura

```text
no_abordado          el tema no aparece
mencionado           se nombra sin contenido propio — NO es cobertura
abordado_parcial     habla del tema pero no cubre lo esencial
abordado_demostrado  lo explica con detalle concreto
```

### Cómo se evitan los falsos positivos

Cuatro capas **en código**, no en el prompt (un modelo de 2B afirma
`abordado_demostrado` con una cita adornada sin despeinarse):

1. Atribución de hablante por construcción (pistas separadas).
2. Verificación literal: cada cita debe aparecer en lo que dijo el CANDIDATO.
3. Democión: sin citas verificadas, `abordado_*` baja a `mencionado` y la nota
   se anula.
4. Suelo de longitud: `abordado_demostrado` exige ≥180 caracteres de citas
   verificadas; `abordado_parcial`, ≥60.

Medido contra el modelo real el 2026-08-07: 4/4 niveles correctos sobre una
transcripción con los cuatro casos conocidos.

### Qué se persiste y qué no

Revisado el **2026-08-10**. Hasta esa fecha no se persistía ni el audio ni la
transcripción, y el precio asumido era que un reinicio a mitad de análisis lo
perdía todo. Ese precio resultó ser demasiado alto en uso real: al caerse el
job desaparecía también el audio —el navegador solo lo tenía en RAM— y una
entrevista ya celebrada se quedaba sin poder evaluarse.

- **SÍ, en disco** (`RECORDINGS_DIR/<recordingId>/`): las pistas de audio tal
  y como se subieron y `transcript.json`. La transcripción se escribe en
  cuanto whisper responde y ANTES de la primera llamada al modelo, que es lo
  que hace que un fallo en el enrutado o la evaluación no cueste retranscribir.
- **SÍ, en la base**: la fila `interview_recording` (índice: dónde están los
  archivos, qué pista es la del candidato, duración y cómo acabó el último
  análisis) y las propuestas con hasta 3 citas de ≤300 caracteres.
- **NO**: nada más. El buffer de audio en RAM se sigue poniendo a cero en
  cuanto whisper responde, y la copia que subió el navegador no sobrevive al
  request.

El **estado del job sigue en memoria**: lo que se recupera de un análisis
caído no es el job, es la grabación. Reintentar crea un job nuevo sobre la
misma grabación, y por eso `interview_recording` guarda `last_status` — una
grabación que quedó en `running` sin job vivo es exactamente la señal de "esto
se cayó, reintenta".

Escritura **atómica** (`.tmp` + `rename`) en los dos archivos: el fallo que
motivó todo esto es un proceso que muere a mitad del trabajo, y un
`transcript.json` a medio escribir sería indistinguible de uno bueno.

### Rutas

```text
POST   /candidates/:id/interview/analysis            (202, multipart mic/tab)
POST   /candidates/:id/interview/analysis/from/:recordingId   (202, JSON)
GET    /candidates/:id/interview/analysis/:jobId
DELETE /candidates/:id/interview/analysis/:jobId
GET    /candidates/:id/interview/recordings
DELETE /candidates/:id/interview/recordings/:recordingId
PATCH  /candidates/:id/interview/proposals/:proposalId
```

Reanalizar NO admite cambiar `candidateSource`: la transcripción guardada ya
está atribuida a un hablante, y reinterpretarla al revés convertiría lo que
preguntó el entrevistador en algo que "demostró" el candidato. Para cambiarla
hay que volver a subir el audio.

Borrar una grabación usa `canDeleteData`, no `canTranscribeInterview`: destruye
datos de forma irreversible.

Aplicar una propuesta NO se hace en esas rutas: se manda el
`PATCH /candidates/:id/questions/:qid/answer` de siempre y después se marca la
propuesta como `applied`. La puntuación real solo la escribe el evaluador por
su camino de siempre.

### Captura desde el navegador

Dos formas de aportar el audio:

- **Grabar** desde la aplicación: micrófono (la sala) y audio de la pestaña de
  la videollamada, en **dos pistas separadas**. `getDisplayMedia` se pide con
  `video: true` porque Chrome no enseña la casilla de "compartir el audio de
  la pestaña" en una petición solo-audio; el vídeo se descarta en el acto.
  Si el usuario no marca esa casilla, se detecta ANTES de grabar y se le da la
  instrucción exacta. Durante la grabación hay cronómetro y un medidor de
  nivel por pista, para descubrir en el minuto 1 que algo no suena y no en el
  50.
- **Subir un archivo**, que funciona siempre. **Aviso**: un archivo con toda
  la conversación en una sola pista NO permite separar hablantes, así que el
  sistema puede tomar por demostrado algo que en realidad preguntó el
  entrevistador. La interfaz lo advierte donde se sube.

`getUserMedia`/`getDisplayMedia` solo existen en contexto seguro (HTTPS o
localhost). No es una comprobación de la aplicación que se pueda relajar:
sobre `http://` fuera de localhost esas funciones no existen en el navegador.
Por eso el servidor de desarrollo sirve **HTTPS con certificado propio**
(2026-08-08, ver §10), y grabar funciona también desde la LAN. Si aun así se
llega por HTTP en claro, la pantalla lo detecta, ofrece la dirección `https://`
equivalente y deja el camino de subir el archivo; nunca se rompe.

### Calidad de la transcripción

Verificado de punta a punta el 2026-08-07 con navegador real: el flujo
completo funciona y discrimina bien los cuatro niveles de cobertura. El punto
débil medido es `Systran/faster-whisper-base`, que en español técnico
degrada bastante ("throttles en CloudWatch" → "trotles en trogwatch"). Eso
ensucia las citas que lee el evaluador y dificulta el emparejamiento.
Pasar a `STT_MODEL=Systran/faster-whisper-small` es cambiar una variable más
un `POST /api/pull/{model}` al contenedor.

