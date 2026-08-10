/**
 * Texto para el placeholder {{analysis_json}} de `generate-questions` cuando
 * el candidato TODAVÍA NO tiene análisis.
 *
 * Generar preguntas no exige análisis previo (decisión del 2026-08-07): basta
 * el resumen del CV y el contexto del rol. El motivo es de coste, no de
 * calidad — obligar a analizar antes gastaba una de las 5 regeneraciones de
 * análisis por candidato (§16) solo para poder preguntar.
 *
 * Se manda una frase en vez de un JSON vacío a propósito: `{}` se lee como
 * "analizado y sin hallazgos", que es justo lo contrario de lo que pasa.
 * El render de PromptLoader lanza si falta cualquier variable, así que el
 * placeholder siempre debe recibir un valor.
 */
export const NO_ANALYSIS_AVAILABLE =
    "(Este candidato aún no tiene análisis. Básate solo en su resumen de CV y en el contexto del rol.)";
