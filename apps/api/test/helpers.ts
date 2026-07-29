import path from "node:path";
import { createDatabase, Database } from "../src/db/database";
import { runMigrations } from "../src/db/migrate";

/** Ruta a las migraciones reales del proyecto. */
export const MIGRATIONS_DIR = path.resolve(process.cwd(), "src/db/migrations");

/**
 * Crea una base de datos SQLite EN MEMORIA con las migraciones aplicadas.
 * Regla del proyecto: ningún test toca data/local.db.
 */
export function createTestDb(): Database {
    const db = createDatabase(":memory:");
    runMigrations(db, MIGRATIONS_DIR);
    return db;
}
