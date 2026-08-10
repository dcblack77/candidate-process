import { CreateModule, interfaces } from "@expressots/core";
import { LlmClient } from "./llm-client";
import { SttClient } from "./stt-client";
import { PromptLoader } from "./prompts";

/**
 * Módulo de IA (BLUEPRINT §18, §20): cliente del modelo local + carga de
 * prompts versionados. Autocontenido y sin controllers: otros módulos
 * (cv, scoring, questions, ranking) inyectan LlmClient.
 *
 * LlmClient y SttClient son singleton a propósito: su cola interna de
 * concurrencia 1 solo protege a llama.cpp y a whisper si existe UNA única
 * instancia de cada uno en la app.
 */
export const AiModule = CreateModule([], (bind: interfaces.Bind) => {
    bind(PromptLoader).toSelf().inSingletonScope();
    bind(LlmClient).toSelf().inSingletonScope();
    bind(SttClient).toSelf().inSingletonScope();
});
