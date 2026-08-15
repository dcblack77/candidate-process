import { ApiError, NETWORK_ERROR_CODE } from "./client";

/**
 * Traducción de códigos de error de la API a mensajes amigables en español.
 * Regla (§17): la UI nunca muestra datos técnicos crudos ni contenido
 * sensible; solo mensajes accionables.
 */
const MESSAGE_BY_CODE: Record<string, string> = {
    LIMIT_EXCEEDED:
        "Se alcanzó el límite permitido para esta acción (p. ej. 5 análisis por candidato, 20 preguntas, 100 candidatos o 10 exportaciones por hora).",
    NOT_FOUND: "No se encontró el recurso solicitado.",
    RATE_LIMITED:
        "Demasiadas peticiones en la última hora (límites por hora: 100 extracciones de CV —sueltas o en lote—, 30 análisis, 60 preguntas, 30 rankings, 20 comparaciones, 30 detecciones de riesgos, 6 análisis de entrevista y 20 reanálisis). Espera un poco y vuelve a intentarlo.",
    INVALID_INPUT: "Los datos enviados no son válidos. Revisa el formulario.",
    LLM_UNAVAILABLE:
        "El modelo local no está disponible. Comprueba que el servidor del modelo esté arrancado e inténtalo de nuevo.",
    STT_UNAVAILABLE:
        "El servicio local de transcripción no responde. Levántalo con `docker compose --profile voice up -d` en /opt/ai-server e inténtalo de nuevo.",
    FORBIDDEN: "No tienes permiso para realizar esta acción.",
    PROCESS_CLOSED:
        "Este proceso está archivado: puedes consultarlo, pero no modificarlo. Reábrelo desde Inicio si necesitas seguir trabajando en él.",
    FILE_TOO_LARGE: "El archivo supera el tamaño máximo permitido (10 MB).",
    UNSUPPORTED_MEDIA_TYPE:
        "Formato de archivo no permitido. Sube un PDF, DOCX o TXT.",
    [NETWORK_ERROR_CODE]:
        "No se pudo contactar con la API local. ¿Está arrancada en el puerto 3010?",
};

/** Mensaje amigable en español para cualquier error capturado por la UI. */
export function friendlyMessage(error: unknown): string {
    if (error instanceof ApiError) {
        return MESSAGE_BY_CODE[error.code] ?? error.message;
    }
    return "Ocurrió un error inesperado. Inténtalo de nuevo.";
}
