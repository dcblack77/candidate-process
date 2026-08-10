# Diseño: carga de la evaluación v2

## Objetivo

Incorporar en `data/local.db` las revisiones y anotaciones de
`Evaluacion_de_candidatos_v2.pdf`, usando el PDF como fuente de verdad y sin
añadir un modelo editorial nuevo al reporte.

## Diseño

- Guardar la nota metodológica y la revisión global de la versión 2 una sola
  vez en `process.role_context`.
- Reemplazar `candidate_score.manual_notes` con el contenido curado de cada
  ficha: formato de entrevista, revisión de rúbrica, dudas resueltas o
  pendientes y valoración final.
- Reemplazar `interview_question.answer_notes` con la evidencia revisada de la
  dimensión correspondiente, conservando IDs, preguntas y timestamps.
- Ante la incoherencia entre una nota detallada y su agregado, conservar el
  valor de la base que mantiene el agregado y el ranking del PDF; explicar la
  revisión únicamente en el texto.
- Cambiar únicamente la nota de Producción revisada a 2,5 y recalcular su score de CV
  con la fórmula canónica. Para representar el dato fielmente, los criterios
  admitirán incrementos de 0,5 entre 1 y 5 en SQLite, API y formulario web.

## Seguridad de la carga

- Crear una copia consistente y fechada de `local.db` antes de escribir.
- Ejecutar migración y actualizaciones dentro de transacciones.
- Resolver candidatos y preguntas por sus IDs existentes; abortar si no está
  el conjunto exacto esperado o si falta alguna pregunta.
- No guardar el PDF ni sus datos personales en archivos versionados del repo.

## Verificación

- Tests de esquema, API y formulario para aceptar 2,5 y rechazar pasos que no
  sean múltiplos de 0,5.
- Consulta final de proceso, rúbrica, agregados de entrevista y longitudes de
  notas.
- Ejecución de tests y build completos.
