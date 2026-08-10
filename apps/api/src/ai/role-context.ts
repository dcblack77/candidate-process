/**
 * Texto neutro para el placeholder {{role_context}} cuando el proceso no
 * tiene `role_context`. Compartido por los tres prompts del flujo que lo
 * reciben (summarize-cv, score-candidate y generate-questions): el render
 * de PromptLoader lanza si falta cualquier variable, así que el placeholder
 * siempre debe recibir un valor.
 */
export const NEUTRAL_ROLE_CONTEXT = "(Sin contexto adicional del rol.)";
