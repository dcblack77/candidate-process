import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// Carga el .env de la RAÍZ del repo (mismo archivo que usa la API) para
// leer WEB_HOST. process.loadEnvFile es nativo de Node 22 y no pisa
// variables ya presentes en el entorno; si el .env no existe, se ignora.
try {
    process.loadEnvFile(resolve(import.meta.dirname, "../../.env"));
} catch {
    /* sin .env: se usan los defaults */
}

/**
 * Vite + vitest para la SPA.
 *
 * Exposición a la red (decisión del usuario, 2026-07-29): la UI escucha por
 * defecto en todas las interfaces (0.0.0.0) para poder usarla desde otros
 * equipos de la LAN. La API NO se expone: sigue atada a 127.0.0.1
 * (BLUEPRINT §10) y solo es alcanzable a través de este proxy, que corre en
 * la máquina servidora. Para volver al modo solo-local: WEB_HOST=127.0.0.1.
 *
 * AVISO: no hay autenticación (§08). Cualquier equipo de la red con acceso
 * al puerto 5173 puede usar la aplicación completa.
 *
 * El proxy reenvía /api → API local quitando el prefijo, así el cliente usa
 * rutas relativas y no hay CORS.
 */
export default defineConfig({
    plugins: [react()],
    server: {
        host: process.env.WEB_HOST ?? "0.0.0.0",
        proxy: {
            "/api": {
                target: "http://127.0.0.1:3010",
                changeOrigin: false,
                rewrite: (path) => path.replace(/^\/api/, ""),
            },
        },
    },
    preview: {
        host: process.env.WEB_HOST ?? "0.0.0.0",
    },
    test: {
        environment: "jsdom",
        globals: false,
        setupFiles: ["./test/setup.ts"],
        include: ["test/**/*.test.{ts,tsx}"],
        restoreMocks: true,
    },
});
