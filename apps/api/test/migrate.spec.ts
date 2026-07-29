import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createDatabase } from "../src/db/database";
import { runMigrations } from "../src/db/migrate";
import { MIGRATIONS_DIR } from "./helpers";

describe("migrador mínimo (sobre :memory:)", () => {
    it("aplica las migraciones reales del proyecto y las registra en _migrations", () => {
        const db = createDatabase(":memory:");
        const { applied } = runMigrations(db, MIGRATIONS_DIR);

        expect(applied).toContain("001_init.sql");

        const rows = db
            .prepare("SELECT name FROM _migrations ORDER BY id")
            .all() as Array<{ name: string }>;
        expect(rows.map((r) => r.name)).toEqual(applied);
    });

    it("es idempotente: una segunda ejecución no re-aplica nada", () => {
        const db = createDatabase(":memory:");
        const first = runMigrations(db, MIGRATIONS_DIR);
        expect(first.applied.length).toBeGreaterThan(0);

        const second = runMigrations(db, MIGRATIONS_DIR);
        expect(second.applied).toEqual([]);

        const count = db
            .prepare("SELECT COUNT(*) AS total FROM _migrations")
            .get() as { total: number };
        expect(count.total).toBe(first.applied.length);
    });

    it("aplica los archivos NNN_*.sql en orden lexicográfico", () => {
        const dir = mkdtempSync(path.join(tmpdir(), "migraciones-"));
        // Se escriben desordenados a propósito.
        writeFileSync(path.join(dir, "002_second.sql"), "CREATE TABLE b (id TEXT);");
        writeFileSync(path.join(dir, "001_first.sql"), "CREATE TABLE a (id TEXT);");
        writeFileSync(path.join(dir, "notas.txt"), "esto no es una migración");

        const db = createDatabase(":memory:");
        const { applied } = runMigrations(db, dir);

        expect(applied).toEqual(["001_first.sql", "002_second.sql"]);
    });

    it("una migración fallida no deja cambios a medias (transacción)", () => {
        const dir = mkdtempSync(path.join(tmpdir(), "migraciones-"));
        writeFileSync(
            path.join(dir, "001_broken.sql"),
            "CREATE TABLE ok_table (id TEXT); INSERT INTO tabla_inexistente VALUES (1);",
        );

        const db = createDatabase(":memory:");
        expect(() => runMigrations(db, dir)).toThrow();

        // Ni la tabla creada ni el registro en _migrations deben persistir.
        const tables = db
            .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='ok_table'")
            .all();
        expect(tables).toHaveLength(0);
        const count = db
            .prepare("SELECT COUNT(*) AS total FROM _migrations")
            .get() as { total: number };
        expect(count.total).toBe(0);
    });
});
