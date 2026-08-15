# Candidate Process

Herramienta **local** para evaluar candidatos a un puesto técnico. Carga CVs, los resume y analiza con un modelo que corre en tu propia máquina, los puntúa contra una rúbrica ponderada, genera preguntas de entrevista con respuestas ideales, transcribe la entrevista grabada y propone notas, produce un ranking justificable y exporta un informe reducido para compartir.

**Nada sale de tu máquina.** No hay proveedores externos, ni telemetría, ni llamadas de red con datos de candidatos. El modelo de lenguaje y el de transcripción corren en local.

El sistema **propone**; la decisión de contratación es siempre humana.

> **Estado**: funcional y en uso, pero con una deuda importante — la base de datos y las grabaciones **no están cifradas en reposo**. Lee [Privacidad](#privacidad-y-seguridad) antes de meter datos de personas reales.

---

## Índice

- [Qué hace](#qué-hace)
- [Requisitos](#requisitos)
- [Instalación](#instalación)
- [Cómo se usa](#cómo-se-usa)
- [Acceso desde otros equipos](#acceso-desde-otros-equipos)
- [Configuración](#configuración)
- [Desarrollo](#desarrollo)
- [Privacidad y seguridad](#privacidad-y-seguridad)
- [Para agentes y LLMs](#para-agentes-y-llms)
- [Licencia](#licencia)

---

## Qué hace

Cada **proceso** cubre un rol técnico. Puedes tener varios abiertos a la vez y saltar entre ellos; abrir uno nuevo no cierra ni borra los anteriores.

Dentro de un proceso, cada candidato recorre este camino:

```text
CV (PDF/DOCX/TXT)
   └─> extracción de texto ──> el archivo original se BORRA
        └─> resumen estructurado con el modelo local
             └─> análisis contra la rúbrica (5 criterios ponderados, 1-5)
                  └─> preguntas de entrevista con respuesta ideal y guía de puntuación
                       └─> [entrevista real]
                            └─> subes o grabas el audio ──> transcripción local
                                 └─> propuestas de nota por pregunta, con citas verificadas
                                      └─> tú aceptas o descartas cada propuesta
                                           └─> ranking + export
```

**La rúbrica** son cinco criterios de 1 a 5, con estos pesos:

| Criterio | Peso |
|---|---:|
| Adaptabilidad | 30 % |
| Fundamentos | 25 % |
| Profundidad | 20 % |
| Producción (operar lo que se construye) | 15 % |
| Stack concreto | 10 % |

El score tiene dos niveles: `score_cv` es lo que **promete** el CV; `score_final` combina `score_cv` al 30 % con la nota de entrevista al 70 %, porque lo que el candidato demuestra pesa más que lo que escribe. Sin entrevista puntuada, el ranking marca la entrada como provisional en vez de penalizar a quien aún no has entrevistado.

---

## Requisitos

- **Node 22+** y **pnpm 11+**.
- **Un modelo de lenguaje local** con API compatible con OpenAI, escuchando en `http://localhost:8080`.
- **Opcional — transcripción de entrevistas**: un servidor de whisper compatible con OpenAI en `http://127.0.0.1:8084`. Sin él, todo lo demás funciona y el panel de audio aparece deshabilitado con el aviso.

### Levantar el modelo de lenguaje

Cualquier servidor compatible con la API de OpenAI sirve. El proyecto está probado con [llama.cpp](https://github.com/ggml-org/llama.cpp) y **Gemma 4 E2B** cuantizado:

```bash
llama-server -m gemma-4-E2B-it-qat-UD-Q4_K_XL.gguf --port 8080 --ctx-size 22016
```

Un modelo pequeño basta: las tareas están troceadas a propósito para que un 2B las resuelva. Si usas otro, ajusta `LLM_MODEL` y `LLM_CONTEXT_TOKENS` en el `.env`.

### Levantar la transcripción (opcional)

```bash
docker run -d --name voice-stt -p 8084:8000 fedirz/faster-whisper-server:latest-cpu
```

Con GPU, usa la etiqueta `latest-cuda`. Ajusta `STT_MODEL` según el equilibrio que quieras entre velocidad y calidad — `Systran/faster-whisper-base` es rápido pero degrada el vocabulario técnico en español ("throttles en CloudWatch" salía como "trotles en trogwatch"); `Systran/faster-whisper-small` lo corrige a cambio de algo más de CPU.

Comprueba que ambos responden:

```bash
curl http://localhost:8080/v1/models
curl http://127.0.0.1:8084/v1/models
```

---

## Instalación

```bash
git clone https://github.com/dcblack77/candidate-process.git
cd candidate-process
pnpm install
cp .env.example .env     # los valores por defecto ya son correctos y seguros
pnpm dev
```

Eso levanta:

- La **API** en `http://127.0.0.1:3010` (solo localhost, siempre).
- La **UI** en `https://localhost:5173`.

`GET /health` dice si las piezas están vivas:

```bash
curl http://127.0.0.1:3010/health
# {"status":"ok","db":true,"llm":true,"stt":true}
```

Si `llm` es `false`, el servidor del modelo no responde. Si `stt` es `false`, solo pierdes el análisis de audio.

> **El primer arranque avisa del certificado.** La UI se sirve por HTTPS con un certificado autofirmado que se genera solo en `certs/`. «Avanzado» → «Continuar»; el navegador lo recuerda. No añade seguridad — está para que el navegador dé acceso al micrófono, sin el cual no se puede grabar la entrevista fuera de `localhost`.

---

## Cómo se usa

### 1. Crea un proceso

En la pantalla inicial, dale un título al rol ("Backend Serverless", "SRE Platform"). Puedes pegar además el **contexto del rol**: la oferta, las responsabilidades, el stack. Ese texto se inyecta en los tres prompts (resumen, puntuación y generación de preguntas), así que cuanto más concreto sea, más pegadas al puesto salen las preguntas y el análisis.

### 2. Añade candidatos y sus CVs

Un candidato es un nombre. Súbele el CV en PDF, DOCX o TXT (máx. 10 MB).

**El archivo original se borra en cuanto se extrae el texto.** No se guarda en disco ni se puede descargar después. Lo que queda es el resumen estructurado, sin datos personales irrelevantes: ni foto, ni edad, ni dirección, ni estado civil, ni nacionalidad.

### 3. Analiza

`Analizar` puntúa el CV contra los cinco criterios. Cada criterio trae evidencia, lo que queda **pendiente de validar en entrevista** y un nivel de confianza. El análisis separa lo que el CV demuestra de lo que solo insinúa: mencionar una tecnología no cuenta como dominarla.

Hasta 5 reanálisis por candidato.

### 4. Genera preguntas

`Generar preguntas` produce hasta 20 preguntas con respuesta ideal, señales positivas, señales de alerta y guía de puntuación. Están pensadas para leerse en voz alta: una sola pregunta por bloque, de unos 200 caracteres.

No hace falta haber analizado antes — basta con tener el CV resumido.

### 5. Entrevista y puntúa

Durante o después de la entrevista, puntúa cada respuesta de 1 a 10 y añade notas privadas.

**Si grabaste la entrevista**, súbela o grábala desde la propia aplicación y deja que la analice: transcribe en local y propone nota y notas para cada pregunta sin puntuar — incluidas las que el candidato respondió sin que se las preguntaras, que es donde más se distorsiona el ranking.

- **Grabar desde la app es mejor que subir un archivo.** Al grabar, el micrófono y el audio de la pestaña de la videollamada van en pistas separadas, y por eso el sistema sabe quién dijo cada cosa. Un archivo con todo mezclado no permite distinguirlo, y el modelo puede dar por demostrado algo que en realidad preguntaste tú.
- Cada propuesta trae **citas literales verificadas** contra lo que dijo el candidato. Si la cita no se sostiene, la propuesta se degrada sola.
- **Nada se aplica automáticamente**: tú aceptas o descartas cada propuesta. La nota real solo la escribes tú.
- El audio y la transcripción quedan guardados para poder **reanalizar** si algo falla. Se borran desde la misma ficha.

### 6. Ranking y export

El ranking ordena por `score_final` con desempates explícitos y enseña de dónde sale cada número.

`Exportar` genera un informe en Markdown o una vista de impresión que el navegador convierte en PDF. **Las notas privadas quedan fuera por defecto**; incluirlas exige marcarlo, y queda auditado.

### 7. Al terminar

**Archivar** deja el proceso en solo lectura conservando todo; es reversible. **Borrar** purga en cascada y pide confirmación explícita. Son cosas distintas a propósito.

---

## Acceso desde otros equipos

La UI escucha en todas las interfaces: desde otro equipo de la red abre `https://<ip-de-la-máquina>:5173`.

La API **no** se expone: sigue atada a `127.0.0.1` (con verificación activa al arrancar que aborta si no lo está) y solo es alcanzable a través del proxy de Vite, que corre en la máquina servidora.

> ⚠️ **No hay autenticación.** Cualquiera con acceso al puerto 5173 puede usar la aplicación entera: leer CVs resumidos, notas privadas, exportar y borrar. Úsalo solo en una red de confianza.

- Si el firewall bloquea el puerto: `sudo firewall-cmd --add-port=5173/tcp --permanent && sudo firewall-cmd --reload` (firewalld) o el equivalente de tu sistema.
- Modo solo-local: `WEB_HOST=127.0.0.1`.
- HTTP sin cifrar, renunciando a grabar fuera de localhost: `WEB_HTTPS=false`.
- Si la máquina cambia de IP, el certificado se regenera al arrancar y los dispositivos tendrán que aceptar la excepción otra vez.

---

## Configuración

Todo va en un `.env` en la raíz (copia de `.env.example`). Los valores por defecto funcionan sin tocar nada.

| Variable | Por defecto | Para qué |
|---|---|---|
| `API_PORT` | `3010` | Puerto de la API. El proxy de la UI lo lee de aquí. |
| `API_HOST` | `127.0.0.1` | **Se fuerza a localhost** si pones otra cosa. |
| `WEB_HOST` | `0.0.0.0` | `127.0.0.1` para no exponer la UI a la red. |
| `WEB_HTTPS` | `true` | `false` sirve en claro (y rompe la grabación fuera de localhost). |
| `DB_PATH` | `./data/local.db` | Base SQLite. |
| `RECORDINGS_DIR` | `./data/interviews` | Audio y transcripciones. Apúntalo a un volumen cifrado si puedes. |
| `LLM_BASE_URL` | `http://localhost:8080` | Servidor del modelo. |
| `LLM_MODEL` | `gemma-4-E2B-it-qat-UD-Q4_K_XL` | Nombre del modelo que espera el servidor. |
| `LLM_CONTEXT_TOKENS` | `22016` | Ventana de contexto; ajusta si tu modelo tiene otra. |
| `STT_BASE_URL` | `http://127.0.0.1:8084` | Servidor de transcripción. |
| `STT_MODEL` | `Systran/faster-whisper-base` | `…-small` transcribe mejor el español técnico. |
| `STT_TIMEOUT_MS` | `600000` | 10 min: una pista de 50 min tarda ~4,5 min en CPU. |

**Límites operativos**: CV ≤ 10 MB · texto extraído ≤ 50 000 caracteres · 100 candidatos por proceso · 5 reanálisis por candidato · 20 preguntas por candidato · 10 exports por hora · audio ≤ 25 MB por pista · 5 grabaciones conservadas por candidato.

---

## Desarrollo

```bash
pnpm dev                # API + UI
pnpm dev:api            # solo API
pnpm dev:web            # solo UI
pnpm test               # suite completa (503 tests)
pnpm --filter api test  # backend (422)
pnpm --filter web test  # frontend (81)
pnpm build              # tsc estricto + bundle
pnpm --filter api lint  # eslint del backend
```

Un test concreto: `pnpm --filter api test -- <patrón>`, por ejemplo `pnpm --filter api test -- weights`.

Los tests del backend usan SQLite `:memory:`, un mock HTTP del modelo y directorios temporales: **nunca tocan tu base de datos, tus grabaciones ni el modelo real**.

### Estructura

```text
apps/api/src/       # ExpressoTS (Express + Inversify) + SQLite (better-sqlite3)
   process/         # procesos (varios abiertos, uno seleccionado)
   candidates/      # candidatos
   cv/              # extracción de texto y borrado del archivo
   ai/              # cliente del modelo, del STT, carga de prompts, schemas
   scoring/         # rúbrica, pesos, análisis, notas de entrevista
   questions/       # generación de preguntas y respuestas
   interview/       # transcripción, propuestas, grabaciones guardadas
   ranking/         # orden y desempates
   export/          # informe markdown y datos para la vista de impresión
   security/        # currentUser y capa de permisos
   db/migrations/   # migrador propio, NNN_*.sql
apps/web/src/       # React + Vite, sin librerías de estado ni UI kits
prompts/            # prompts versionados en el repo, no incrustados en el código
```

Organización **por dominio, no por capa técnica**: cada carpeta lleva su controller, sus casos de uso y su repositorio.

---

## Privacidad y seguridad

Estas reglas condicionan casi todo el código:

- **El CV original nunca se persiste.** Subida en memoria, extracción, resumen y descarte. No se sirve desde ninguna ruta.
- **Todo el procesamiento es local.** Ningún proveedor externo, ninguna llamada saliente con datos de candidatos.
- **La API solo escucha en localhost**, con verificación activa que aborta el arranque si no es así.
- **No se guardan datos personales irrelevantes** aunque estén en el CV: foto, edad, dirección, nacionalidad, estado civil.
- **Nada sensible en logs ni en errores**: ni texto del CV, ni resúmenes, ni prompts con datos personales, ni notas privadas.
- **Los exports excluyen las notas privadas por defecto.**
- **Los permisos se validan en el backend**, no ocultando botones.
- **El audio de entrevista y su transcripción sí se conservan**, en `data/interviews/`. Antes no, pero si el análisis se caía a mitad se perdía también la grabación —el navegador solo la tenía en memoria— y una entrevista ya celebrada se quedaba sin poder evaluarse. Ahora se reanaliza sin repetir nada. El audio no se sirve desde ninguna dirección: solo se reanaliza o se borra. Se lista en la ficha con su tamaño, se borra desde ahí, y desaparece al purgar el proceso.

### Deuda técnica conocida

- **Sin cifrado en reposo.** Ni `data/local.db` ni `data/interviews/` están cifrados. Resuélvelo (SQLCipher, o cifrado de disco) **antes de usar el sistema con datos de personas reales**. Mitigación mínima: cifrado de disco activado y `data/` fuera de cualquier carpeta sincronizada a la nube. La deuda pesa más desde que archivar conserva los datos y desde que se guardan grabaciones: lo que hay en disco incluye **la voz completa de personas identificables**, no solo texto.
- **Sin autenticación.** La protección es la red. Ver [Acceso desde otros equipos](#acceso-desde-otros-equipos).
- **Consentimiento**: grabar y conservar una entrevista obliga a informar al candidato. El sistema no lo gestiona; es responsabilidad de quien entrevista.

---

## Para agentes y LLMs

Si eres un modelo trabajando sobre este repositorio, empieza por aquí.

```bash
git clone https://github.com/dcblack77/candidate-process.git
cd candidate-process
pnpm install
pnpm test          # 503 tests; deben pasar todos antes de tocar nada
```

**Los dos documentos que mandan**, por este orden:

1. **[BLUEPRINT.md](BLUEPRINT.md)** — la especificación funcional y de seguridad. Es la fuente de verdad sobre alcance, modelo de datos y reglas. Ante cualquier duda, consúltalo antes de improvisar. Si una decisión lo contradice, hay que actualizarlo **en el mismo cambio**.
2. **[CLAUDE.md](CLAUDE.md)** — las decisiones de implementación y el porqué de lo que parece raro. Léelo antes de "arreglar" nada que parezca un despiste: buena parte de lo que lo parece está así por una razón medida.

**Invariantes que no puedes romper** (§04, §08, §10, §16, §17, §23 del blueprint):

- El CV original no se persiste jamás.
- Todo el procesamiento de IA es local; ninguna llamada saliente con datos de candidatos.
- La API solo escucha en `localhost`.
- Toda acción resuelve `currentUser` y **valida permisos en el backend**.
- Nada sensible en logs ni en mensajes de error.
- No se persisten datos personales irrelevantes.

**Convenciones que sorprenden si no las conoces:**

- `@inject` **siempre explícito** en el backend. Se ejecuta con `tsx`, que no emite `design:paramtypes`; sin el decorador explícito la inyección falla en runtime, no en compilación.
- **Un módulo por dominio** (controller + casos de uso + repositorio). `health/` es el ejemplo de referencia, el más pequeño.
- **Los prompts son archivos** en `prompts/*.md`, versionados junto al código que los consume. No incrustes prompts en strings.
- **`scoring/weights.ts` es la única fuente** de pesos y desempates. El modelo nunca calcula el score final: lo recalcula siempre el backend.
- **SQL directo** con better-sqlite3 (síncrono) y migrador propio en `db/migrations/NNN_*.sql`. No hay ORM.
- El frontend mantiene **tipos espejo** de los DTOs en `apps/web/src/api/types.ts`. Si cambias un DTO del backend, actualiza el espejo.
- **Documentación, comentarios y prompts en español**; identificadores de código en inglés.

**Antes de dar por terminado un cambio**: `pnpm test`, `pnpm build` y `pnpm --filter api lint` en verde, y el blueprint actualizado si tocaste una regla.

---

## Licencia

[MIT](LICENSE).
