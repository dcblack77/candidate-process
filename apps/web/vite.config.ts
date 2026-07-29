import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

/**
 * Vite + vitest para la SPA local (BLUEPRINT §03: nada se expone fuera de
 * localhost). El proxy reenvía /api → API local quitando el prefijo, así el
 * cliente usa rutas relativas y no hay CORS.
 */
export default defineConfig({
    plugins: [react()],
    server: {
        host: "127.0.0.1",
        proxy: {
            "/api": {
                target: "http://127.0.0.1:3010",
                changeOrigin: false,
                rewrite: (path) => path.replace(/^\/api/, ""),
            },
        },
    },
    test: {
        environment: "jsdom",
        globals: false,
        setupFiles: ["./test/setup.ts"],
        include: ["test/**/*.test.{ts,tsx}"],
        restoreMocks: true,
    },
});
