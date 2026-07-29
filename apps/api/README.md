# api — API local de evaluación de candidatos

Backend ExpressoTS v4 del sistema descrito en `../../BLUEPRINT.md`.
La API escucha **solo en 127.0.0.1** (invariante §10) y persiste en SQLite
(`data/local.db` en la raíz del repo; los tests usan siempre `:memory:`).

## Comandos (desde la raíz del repo)

```bash
pnpm install               # dependencias del workspace
pnpm --filter api dev      # servidor en http://127.0.0.1:3010 (tsx watch)
pnpm --filter api build    # compila a dist/ (tsc + copia de migraciones .sql)
pnpm --filter api test     # tests con vitest (DB siempre en memoria)
```

## Estructura

- `src/main.ts` — entrada: carga entorno y arranca `bootstrap(App)`.
- `src/app.ts` — ciclo de vida ExpressoTS; fuerza el bind a localhost.
- `src/app.module.ts` — módulo transversal: env, DB migrada, auditoría, rate limiter.
- `src/env.ts` — `.env` de la raíz validado con zod (tipado e inyectable).
- `src/db/` — better-sqlite3 (WAL, FK), migrador mínimo y `migrations/*.sql`.
- `src/security/` — `currentUser`, capa de permisos (§09) y rate limiter (§16).
- `src/shared/` — `AppError` + error handler sin datos sensibles, auditoría
  `app_event`, límites (§16) e ids.
- `src/health/` — módulo de referencia (controller + usecase + module) para
  las fases siguientes.
