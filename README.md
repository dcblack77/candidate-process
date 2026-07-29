# Candidate Process

Herramienta **local** para comparar candidatos de un único rol técnico: carga CVs, los resume y analiza con un modelo local (Gemma4-e2b vía llama.cpp), los puntúa contra una rúbrica ponderada, genera preguntas de entrevista con respuestas ideales, muestra un ranking justificable y exporta una versión limitada para compartir con el líder.

La especificación completa vive en [BLUEPRINT.md](BLUEPRINT.md). El sistema **propone**; la decisión de contratación es siempre humana.

## Requisitos

- Node 22+ y pnpm.
- Modelo local sirviendo en `http://localhost:8080` con API compatible OpenAI (llama.cpp con `gemma-4-E2B-it-qat`). Configurable vía `LLM_BASE_URL`.

## Puesta en marcha

```bash
pnpm install
cp .env.example .env    # opcional: los defaults ya son seguros
pnpm dev                # API en http://127.0.0.1:3010 + UI en http://127.0.0.1:5173
```

Scripts útiles:

```bash
pnpm dev:api            # solo API
pnpm dev:web            # solo frontend
pnpm test               # suite completa (api + web)
pnpm --filter api test  # solo backend (190 tests)
pnpm --filter web test  # solo frontend (16 tests)
pnpm build              # build de ambas apps
bash scripts/smoke.sh   # smoke E2E contra la API y el modelo real (API arrancada antes)
```

Para ejecutar un test concreto: `pnpm --filter api test -- <patrón>` (p. ej. `pnpm --filter api test -- weights`).

## Estructura

```text
apps/api    # ExpressoTS + SQLite (better-sqlite3). Dominios: process, candidates,
            # cv, ai, scoring, questions, ranking, export, security, shared
apps/web    # React + Vite (SPA local, proxy /api → 127.0.0.1:3010)
prompts/    # prompts versionados que consume la capa ai (§18)
data/       # local.db (gitignored)
scripts/    # smoke.sh
```

## Privacidad y seguridad (invariantes)

- El **CV original nunca se persiste**: upload en memoria, extracción de texto, resumen con el modelo y descarte del buffer. Solo se guarda el resumen estructurado.
- Todo el procesamiento de IA es **local**; ningún dato sale de la máquina.
- API y UI escuchan **solo en 127.0.0.1** (verificación activa en el arranque).
- Los exports **excluyen por defecto** las notas privadas; incluirlas exige un flag explícito y queda auditado.
- Nada de contenido de CVs, resúmenes o notas en logs ni en mensajes de error.
- Al cerrar el proceso, los datos se **borran en cascada** previa confirmación explícita.

## Deuda técnica

- **Cifrado en reposo pendiente** (BLUEPRINT §17): la base `data/local.db` no está cifrada. Debe resolverse (p. ej. SQLCipher o cifrado a nivel de disco) **antes de usar el sistema con datos reales de candidatos**. Mitigación temporal: la máquina debe tener cifrado de disco activado y `data/` no debe sincronizarse a la nube.
- Los mensajes de `RATE_LIMITED`/`LIMIT_EXCEEDED` del backend no incluyen el valor del límite; la UI lo compensa con textos propios (§16).
