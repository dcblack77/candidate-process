import { mkdtempSync, rmSync } from "node:fs";
import { Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { createModule, interfaces } from "@expressots/core";
import supertest from "supertest";
import { App } from "../src/app";
import { Database, DB } from "../src/db/database";
import { AppEnv, ENV, loadEnv } from "../src/env";
import { ExportSessionCounter } from "../src/export/export-session";
import { RateLimiter } from "../src/security/rate-limit";
import { AuditRepository } from "../src/shared/audit";
import { createTestDb } from "./helpers";

/**
 * Helper de integración: levanta la App ExpressoTS REAL (mismos módulos,
 * middlewares, controllers y error handler que producción) pero con la base
 * de datos ":memory:" en lugar de data/local.db.
 *
 * - `App` acepta el módulo core por constructor; aquí se le pasa un
 *   TestCoreModule con los mismos bindings que CoreModule salvo la DB.
 * - Se escucha en puerto 0 (efímero, siempre en 127.0.0.1 por el patch de
 *   App) y supertest ataca el http.Server directamente.
 */

export interface TestApp {
    /** Conexión a la DB en memoria, para sembrar datos y hacer asserts. */
    db: Database;
    /** Cliente supertest apuntando a la app real. */
    request: ReturnType<typeof supertest>;
    /**
     * Directorio temporal donde esta app escribe las grabaciones (§24). Igual
     * que la DB va a ":memory:", esto va a /tmp: ningún test puede escribir
     * audio en `data/interviews` del repo.
     */
    recordingsDir: string;
    /**
     * Vacía el contador de exportaciones por sesión (§16: 10 por sesión de
     * la API). Es un singleton del contenedor y NO lo limpia `resetDb`: sin
     * esto, los tests de export se contaminan entre sí.
     */
    resetExportCounter(): void;
    /** Cierra el servidor HTTP (llamar en afterAll). */
    close(): Promise<void>;
}

export async function createTestApp(): Promise<TestApp> {
    const db = createTestDb();

    const recordingsDir = mkdtempSync(
        path.join(os.tmpdir(), "candidate-recordings-"),
    );

    const TestCoreModule = createModule((bind: interfaces.Bind) => {
        bind<AppEnv>(ENV).toConstantValue({
            ...loadEnv(),
            RECORDINGS_DIR: recordingsDir,
        });
        bind<Database>(DB).toConstantValue(db);
        bind(AuditRepository).toSelf().inSingletonScope();
        bind(RateLimiter).toSelf().inSingletonScope();
    });

    const app = new App(TestCoreModule);
    await app.listen(0);
    const server: Server = await app.getHttpServer();

    return {
        db,
        request: supertest(server),
        recordingsDir,
        resetExportCounter: () =>
            app.diContainer.Container.get(ExportSessionCounter).reset(),
        close: () =>
            new Promise<void>((resolve, reject) => {
                rmSync(recordingsDir, { recursive: true, force: true });
                server.close((error) => (error ? reject(error) : resolve()));
            }),
    };
}

/**
 * Vacía todas las tablas de dominio entre tests. Borrar `process` arrastra
 * candidatos, puntuaciones y preguntas por FK CASCADE.
 */
export function resetDb(db: Database): void {
    db.exec("DELETE FROM process; DELETE FROM app_event;");
}

/** Filas de app_event para una acción dada (asserts de auditoría). */
export function eventsByAction(
    db: Database,
    action: string,
): Array<{
    entity_type: string | null;
    entity_id: string | null;
    metadata: string | null;
}> {
    return db
        .prepare(
            "SELECT entity_type, entity_id, metadata FROM app_event WHERE action = ? ORDER BY created_at",
        )
        .all(action) as Array<{
        entity_type: string | null;
        entity_id: string | null;
        metadata: string | null;
    }>;
}

/** COUNT(*) de una tabla (asserts de purga). */
export function countRows(db: Database, table: string): number {
    const row = db.prepare(`SELECT COUNT(*) AS total FROM ${table}`).get() as {
        total: number;
    };
    return row.total;
}
