import { mkdirSync } from "node:fs";
import path from "node:path";
import BetterSqlite3 from "better-sqlite3";

/**
 * Acceso a SQLite con better-sqlite3.
 *
 * - `journal_mode = WAL`: lecturas concurrentes sin bloquear escrituras.
 * - `foreign_keys = ON`: las FK (con ON DELETE CASCADE) se aplican de verdad.
 *
 * En tests se usa SIEMPRE ":memory:"; data/local.db es solo para runtime.
 */

export type Database = BetterSqlite3.Database;

/** Token DI para inyectar la conexión a base de datos. */
export const DB = Symbol.for("Database");

/**
 * Abre (o crea) la base de datos en `dbPath` y aplica los PRAGMA del proyecto.
 * Crea el directorio padre si no existe.
 */
export function createDatabase(dbPath: string): Database {
    if (dbPath !== ":memory:") {
        mkdirSync(path.dirname(dbPath), { recursive: true });
    }
    const db = new BetterSqlite3(dbPath);
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    return db;
}
