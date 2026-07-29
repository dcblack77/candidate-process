import { ExportCandidateDTO, ExportInclude, ExportQuestionDTO } from "./export.dto";
import { ExportCandidateData } from "./markdown-builder";

/**
 * Proyección del export a datos ESTRUCTURADOS (BLUEPRINT §19, formato PDF).
 *
 * Parte exactamente de los mismos {@link ExportCandidateData} que alimentan el
 * markdown-builder: la selección de datos (qué candidatos, en qué orden, con
 * qué fortalezas y riesgos) la hace una sola vez el caso de uso. Aquí solo se
 * aplican las banderas de `include`, con las MISMAS reglas que el markdown:
 *
 * - `privateNotes=false` (default seguro §17) borra las notas del evaluador Y
 *   el TEXTO de las respuestas de entrevista. No se "ocultan en la vista": no
 *   salen de la API, porque el JSON viaja al navegador tal cual.
 * - Las notas NUMÉRICAS de entrevista (global, por criterio y por pregunta)
 *   sí salen siempre: son puntuación, no texto sensible (§19).
 * - Una sección desactivada llega vacía (`[]`) o `null`, nunca con el dato
 *   dentro para que la UI decida: la decisión es del backend.
 * - `scoresByCriterion=false` deja `scores`/`verdicts` a null, pero el score
 *   final y el de CV siguen (son el ranking, no el detalle por criterio).
 */
export function toExportCandidateDTOs(
    entries: ExportCandidateData[],
    include: ExportInclude,
): ExportCandidateDTO[] {
    return entries.map((entry) => toExportCandidateDTO(entry, include));
}

function toExportCandidateDTO(
    entry: ExportCandidateData,
    include: ExportInclude,
): ExportCandidateDTO {
    const showCriteria = include.scoresByCriterion;
    return {
        position: entry.position,
        name: entry.name,
        cvScore: entry.cvScore,
        overallScore: entry.overallScore,
        provisional: entry.provisional,
        scores: showCriteria ? entry.scores : null,
        verdicts: showCriteria ? entry.verdicts : null,
        confidence: entry.confidence,
        needsManualReview: entry.needsManualReview,
        summary: include.summary ? entry.summary : null,
        strengths: include.strengths ? entry.strengths : [],
        // Riesgos y dudas pendientes comparten bandera: ambos son "lo que
        // queda por verificar" y el usuario los elige con un único checkbox.
        risks: include.risks ? entry.risks : [],
        doubts: include.risks ? entry.doubts : [],
        questions: include.questions
            ? entry.questions.map((question) =>
                  toExportQuestionDTO(question, include),
              )
            : [],
        interview: entry.interview,
        manualNotes: include.privateNotes ? entry.manualNotes : null,
    };
}

function toExportQuestionDTO(
    question: ExportCandidateData["questions"][number],
    include: ExportInclude,
): ExportQuestionDTO {
    return {
        question: question.question,
        // La nota numérica no es dato sensible (§19).
        answerScore: question.answerScore,
        // El TEXTO de la respuesta sí lo es (§17).
        answerNotes: include.privateNotes ? question.answerNotes : null,
    };
}
