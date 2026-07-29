import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { Database } from "./database";

/**
 * Migrador mínimo:
 * - Mantiene la tabla `_migrations` con los archivos ya aplicados.
 * - Aplica en orden lexicográfico los `NNN_*.sql` de db/migrations que falten,
 *   cada uno dentro de una transacción.
 * - Es idempotente: volver a ejecutarlo no re-aplica migraciones.
 */

const MIGRATION_FILE_REGEX = /^\d{3}_.+\.sql$/;

/**
 * Carpeta de migraciones por defecto: junto a este archivo (src y dist son
 * CJS y tienen `__dirname`). Bajo vitest (ESM) no existe `__dirname`, así
 * que caemos a la ruta del paquete; los tests además la pasan explícita.
 */
export function defaultMigrationsDir(): string {
    if (typeof __dirname !== "undefined") {
        return path.join(__dirname, "migrations");
    }
    return path.resolve(process.cwd(), "src/db/migrations");
}

export interface MigrationResult {
    /** Nombres de las migraciones aplicadas en esta ejecución, en orden. */
    applied: string[];
}

export function runMigrations(
    db: Database,
    migrationsDir: string = defaultMigrationsDir(),
): MigrationResult {
    db.exec(
        `CREATE TABLE IF NOT EXISTS _migrations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL UNIQUE,
            applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
        )`,
    );

    const alreadyApplied = new Set(
        db
            .prepare("SELECT name FROM _migrations ORDER BY name")
            .all()
            .map((row) => (row as { name: string }).name),
    );

    const pending = readdirSync(migrationsDir)
        .filter((file) => MIGRATION_FILE_REGEX.test(file))
        .sort()
        .filter((file) => !alreadyApplied.has(file));

    const applied: string[] = [];
    const insertMigration = db.prepare(
        "INSERT INTO _migrations (name) VALUES (?)",
    );

    for (const file of pending) {
        const sql = readFileSync(path.join(migrationsDir, file), "utf8");
        // Cada migración se aplica de forma atómica: o entra entera o no entra.
        db.transaction(() => {
            db.exec(sql);
            insertMigration.run(file);
        })();
        applied.push(file);
    }

    return { applied };
}
