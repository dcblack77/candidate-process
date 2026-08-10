import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";
import { type TlsMaterial, ensureDevCertificate } from "./dev/tls";

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
 * HTTPS con certificado propio (decisión del usuario, 2026-08-08): sin TLS el
 * navegador no da acceso al micrófono fuera de localhost, así que grabar la
 * entrevista (§24) era imposible desde la LAN. El certificado se genera solo
 * en `certs/` — ver dev/tls.ts. Para volver a HTTP en claro: WEB_HTTPS=false.
 *
 * El proxy reenvía /api → API local quitando el prefijo, así el cliente usa
 * rutas relativas y no hay CORS. El puerto sale de API_PORT (mismo .env que
 * la API) para no duplicar el valor en dos sitios. El destino sigue siendo
 * HTTP porque la API vive en esta misma máquina, atada a 127.0.0.1.
 */
const apiPort = process.env.API_PORT ?? "3010";
const CERTS_DIR = resolve(import.meta.dirname, "../../certs");

/**
 * Prepara el certificado, salvo en tests y builds (generarlo cuesta cientos
 * de milisegundos y escribe en disco). Si algo falla se sigue en HTTP: mejor
 * arrancar sin poder grabar que no arrancar.
 */
async function resolveHttps(command: string): Promise<TlsMaterial | undefined> {
    const disabled = process.env.WEB_HTTPS === "false";
    if (disabled || command !== "serve" || process.env.VITEST) {
        return undefined;
    }
    try {
        return await ensureDevCertificate(CERTS_DIR);
    } catch (error) {
        console.warn(
            `[vite] no se pudo preparar el certificado (${
                error instanceof Error ? error.message : "error desconocido"
            }); la UI arranca en HTTP y no se podrá grabar fuera de localhost.`,
        );
        return undefined;
    }
}

export default defineConfig(async ({ command }) => {
    const https = await resolveHttps(command);
    return {
        plugins: [react()],
        server: {
            host: process.env.WEB_HOST ?? "0.0.0.0",
            https,
            proxy: {
                "/api": {
                    target: `http://127.0.0.1:${apiPort}`,
                    changeOrigin: false,
                    rewrite: (path: string) => path.replace(/^\/api/, ""),
                },
            },
        },
        preview: {
            host: process.env.WEB_HOST ?? "0.0.0.0",
            https,
        },
        test: {
            environment: "jsdom",
            globals: false,
            setupFiles: ["./test/setup.ts"],
            include: ["test/**/*.test.{ts,tsx}"],
            restoreMocks: true,
        },
    };
});
