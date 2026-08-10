import { createModule, interfaces } from "@expressots/core";
import { createDatabase, Database, DB } from "./db/database";
import { runMigrations } from "./db/migrate";
import { AppEnv, ENV, loadEnv } from "./env";
import { pruneOrphanRecordings } from "./interview/recording-store";
import { RateLimiter } from "./security/rate-limit";
import { AuditRepository } from "./shared/audit";

/**
 * Módulo transversal de infraestructura: entorno tipado, base de datos
 * migrada, auditoría y rate limiter. Se carga al construir la App, por lo
 * que las migraciones corren SIEMPRE al arrancar, antes de aceptar tráfico.
 */
export const CoreModule = createModule((bind: interfaces.Bind) => {
    const env = loadEnv();
    const db = createDatabase(env.DB_PATH);
    const { applied } = runMigrations(db);
    if (applied.length > 0) {
        // Log sin datos sensibles: solo nombres de archivos de migración.
        console.info(`[db] migraciones aplicadas: ${applied.join(", ")}`);
    }

    // Barrido de grabaciones huérfanas (§24): audio sin fila que lo respalde
    // es audio que nadie puede ver ni borrar desde la aplicación.
    const known = new Set(
        db
            .prepare("SELECT id FROM interview_recording")
            .all()
            .map((row) => (row as { id: string }).id),
    );
    const orphans = pruneOrphanRecordings(env.RECORDINGS_DIR, known);
    if (orphans.length > 0) {
        console.info(`[recordings] huérfanas borradas: ${orphans.length}`);
    }

    bind<AppEnv>(ENV).toConstantValue(env);
    bind<Database>(DB).toConstantValue(db);
    bind(AuditRepository).toSelf().inSingletonScope();
    bind(RateLimiter).toSelf().inSingletonScope();
});
