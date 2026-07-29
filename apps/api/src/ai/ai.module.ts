import { CreateModule, interfaces } from "@expressots/core";
import { LlmClient } from "./llm-client";
import { PromptLoader } from "./prompts";

/**
 * Módulo de IA (BLUEPRINT §18, §20): cliente del modelo local + carga de
 * prompts versionados. Autocontenido y sin controllers: otros módulos
 * (cv, scoring, questions, ranking) inyectan LlmClient.
 *
 * LlmClient es singleton a propósito: su cola interna de concurrencia 1
 * solo protege a llama.cpp si existe UNA única instancia en la app.
 */
export const AiModule = CreateModule([], (bind: interfaces.Bind) => {
    bind(PromptLoader).toSelf().inSingletonScope();
    bind(LlmClient).toSelf().inSingletonScope();
});
