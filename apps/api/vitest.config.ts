import { defineConfig } from "vitest/config";

// Los tests corren en Node y usan SIEMPRE SQLite en memoria (":memory:").
// Regla del proyecto: ningún test toca data/local.db.
export default defineConfig({
    test: {
        environment: "node",
        include: ["test/**/*.spec.ts"],
    },
});
