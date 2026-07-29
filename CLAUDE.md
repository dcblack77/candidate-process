# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Estado del repositorio

Proyecto **greenfield**: hoy solo existe `BLUEPRINT.md`. No hay código, ni `package.json`, ni gestor de dependencias, ni tests, ni repositorio git inicializado. Por tanto **no hay comandos de build/lint/test todavía**; cuando se implemente el primer módulo hay que elegir stack, añadir el toolchain y documentar aquí los comandos reales.

`BLUEPRINT.md` es la fuente de verdad funcional y de seguridad. Ante cualquier duda de alcance, modelo de datos o reglas, consultarlo antes de improvisar; si una decisión lo contradice, actualizar el blueprint en el mismo cambio.

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

```text
score_final = adaptabilidad*0.30 + fundamentos*0.25 + profundidad*0.20 + produccion*0.15 + stack*0.10
```

Desempate, en orden: adaptabilidad → fundamentos → producción → profundidad → stack → confianza → revisión manual. Los pesos y el orden de desempate viven en un único sitio del código; no duplicarlos.

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
