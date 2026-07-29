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

Cada criterio se puntúa de 1 a 5.

Fórmula:

```text
score_final =
  adaptabilidad * 0.30 +
  fundamentos * 0.25 +
  profundidad * 0.20 +
  produccion * 0.15 +
  stack * 0.10
```

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
Qué busca validar
Respuesta ideal
Señales positivas
Señales de alerta
Guía de puntuación
```

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

GET    /process
POST   /process
PATCH  /process
POST   /process/close
DELETE /process

GET    /candidates
POST   /candidates
GET    /candidates/:id
PATCH  /candidates/:id
DELETE /candidates/:id

POST   /candidates/:id/cv/extract
POST   /candidates/:id/analyze
POST   /candidates/:id/questions
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
14. Al cerrar el proceso, Admin borra los datos.

## 12. Modelo De Datos

### Process

```text
id
role_title
role_context
status
created_at
closed_at
```

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
- Priorizar resultados concretos.
- Detectar transiciones tecnológicas demostradas.
- Señalar qué debe validarse en entrevista.
- Ignorar datos personales irrelevantes.

## 14. Generación De Preguntas

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
Qué valida:
Respuesta ideal:
Señales positivas:
Señales de alerta:
Cómo puntuar:
```

Ejemplo:

```text
Pregunta:
Cuéntame una transición tecnológica concreta que hayas hecho. ¿Qué no sabías al inicio, qué hiciste para aprenderlo y qué entregaste después?

Dimensión:
Velocidad, aprendizaje y contribución.

Criterio:
Adaptabilidad.

Respuesta ideal:
Describe una transición específica, explica el contexto, identifica brechas iniciales, muestra método de aprendizaje y menciona entregables concretos posteriores.

Señales positivas:
Da fechas aproximadas, habla de decisiones técnicas, explica trade-offs y conecta aprendizaje con impacto real.

Señales de alerta:
Responde con generalidades, solo menciona cursos o no puede explicar qué entregó después de la transición.

Cómo puntuar:
1 si no hay evidencia clara.
3 si hubo adaptación parcial.
5 si hubo transición demostrada, rápida y con contribución real.
```

## 15. Ranking

El ranking debe mostrar:

- Posición.
- Nombre del candidato.
- Score final.
- Score por criterio.
- Evidencia resumida.
- Confianza del análisis.
- Dudas pendientes.
- Preguntas clave.

Reglas de desempate:

1. Mayor adaptabilidad.
2. Mayor fundamentos.
3. Mayor producción.
4. Mayor profundidad.
5. Mayor stack.
6. Mayor confianza.
7. Revisión manual.

## 16. Restricciones, Reglas Y Límites De Uso

Restricciones:

- Solo un proceso activo en MVP.
- Solo usuario Admin.
- Solo rol objetivo único.
- No se guardan CVs originales.
- No se usan proveedores externos de IA.
- No se expone la API fuera de local.
- No se aceptan archivos fuera de los formatos permitidos.
- No se muestran notas privadas completas en exports por defecto.
- Al cerrar el proceso debe existir opción clara de borrado.

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

Rate limiting local:

| Acción | Límite |
|---|---:|
| Extracción de CV | 20 por hora |
| Análisis con Gemma4-e2b | 30 por hora |
| Generación de preguntas | 60 por hora |
| Regeneración de ranking | 30 por hora |

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

- Al cerrar el proceso, el sistema debe permitir borrar candidatos, resúmenes, evidencias, puntuaciones, preguntas, notas y ranking.
- El borrado definitivo debe pedir confirmación.
- No debe quedar copia del CV original.

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

- Ranking.
- Nombre del candidato.
- Score final.
- Score por criterio.
- Resumen breve.
- Fortalezas.
- Riesgos.
- Preguntas recomendadas.

No incluye por defecto:

- CV original.
- Texto completo extraído.
- Notas privadas completas.
- Datos personales irrelevantes.
- Prompts.
- Información sensible innecesaria.

Formato recomendado:

```text
Markdown primero
PDF después
```

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

- Ver proceso activo.
- Crear proceso.
- Continuar análisis.
- Cerrar proceso.

### Candidatos

- Lista de candidatos.
- Añadir candidato.
- Cargar CV.
- Ver estado de análisis.

### Detalle De Candidato

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

### Cerrar Proceso

- Confirmar cierre.
- Exportar antes de borrar.
- Borrar datos del proceso.

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
- Datos: se borran al terminar el proceso.
- Rol: único rol técnico.
- Visibilidad: notas y puntuaciones privadas para mí.
- Exportación: versión limitada para mostrar al líder.
