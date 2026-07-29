import { bootstrap } from "@expressots/core";
import { App } from "./app";
import { loadEnv } from "./env";

/**
 * Punto de entrada de la API.
 *
 * `loadEnv()` lee el `.env` de la raíz del repo y valida con zod
 * (forzando API_HOST local). `bootstrap(App)` construye el contenedor DI,
 * ejecuta el ciclo de vida de AppExpress y arranca el servidor HTTP
 * (solo en localhost; ver App.forceLocalhostBinding).
 */
const env = loadEnv();

void bootstrap(App, {
    port: env.API_PORT,
    appName: "candidate-process-api",
});
