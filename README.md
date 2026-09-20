# dsh-plugin-alfresco-migrator

Plugin de [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`) para migraciones de
**Alfresco Content Services**. El arnés aporta el **loop, la memoria de sesión y las herramientas**; este
plugin aporta el **dominio** (rutas de versión, esquemas de referencia, recomendaciones oficiales) y
**encapsula la seguridad** (el origen es inmutable; la escritura solo va al destino y con aprobación).

## Instalación y uso (rápido)
El repo es **privado**: necesitas `gh` autenticado o credenciales git. Clona y ejecuta el instalador:
```sh
gh repo clone horelvis/dsh-alfresco-migrator ~/.local/share/alfresco-dsh-horcas -- --depth 1
~/.local/share/alfresco-dsh-horcas/install.sh
```
O, en un solo paso (bootstrap remoto autenticado con `gh`):
```sh
curl -fsSL -H "Authorization: Bearer $(gh auth token)" \
  https://raw.githubusercontent.com/horelvis/dsh-alfresco-migrator/main/bootstrap.sh | sh
```
O desde el repo ya clonado:
```sh
./install.sh                    # deps + build + bundle en el perfil dsh + comando global `alfresco-dsh-horcas`
cp .env.example .env            # rellena credenciales del origen y modelo

alfresco-dsh-horcas             # abre la UI web (recomendado)
alfresco-dsh-horcas headless "analiza en solo lectura la migracion de data/projects/example.yaml"
alfresco-dsh-horcas --help      # ayuda completa
```
Sin instalar, desde el repo: `./alfresco-dsh-horcas ...`. Requiere `dsh` y Node ≥ 20 (o `npx`).
Detalle en [Instalación y lanzamiento](#instalación-y-lanzamiento) y en [dsh y el plugin](#dsh-y-el-plugin-no-duplicar).

## Por qué sobre dsh
Una migración no termina en un día: se necesita memoria entre sesiones, razonamiento iterativo con
herramientas y observabilidad. Eso ya lo ofrece dsh; aquí solo se porta la experiencia del agente Spring.

## Herramientas
Read-only (permitidas por defecto):
- `migrator_upgrade_path` — ruta soportada desde `from` a `to` + gates de breaking changes.
- `migrator_schema_versions` — versiones de referencia de esquema disponibles.
- `migrator_schema_check` — PK/UNIQUE del PostgreSQL del origen vs la referencia de su versión.
- `migrator_recommendations` — recomendaciones oficiales para códigos de hallazgo.
- `migrator_rehearsal_record` — registra la experiencia de una migración de prueba (clone/TEST).
- `migrator_experience_latest` — consulta el último ensayo registrado.
- `migrator_environment_parity` — drift del origen actual respecto al ensayo (BLOCKER impide PROD).
- `migrator_verify_target` — paridad origen→destino: conteos JDBC (nodos/refs) y content store (ficheros/bytes).
- `migrator_coherence` — coherencia DB↔content store (refs/dangling/orphans/**sizeMismatch**/verdict).
- `migrator_dangling_explain` — para cada colgante, nodo (vivo/versión/papelera), tipo, nombre y ruta.
- `migrator_strategy` — estrategia recomendada de contenido/BD/índice (C1–C5/D1–D2/I1–I2).
- `migrator_estimate` — estimación por fases (assessment/pre-staging/cutover/post), cuello y riesgos.
- `migrator_checklist` — checklist pre/post-cutover version-aware (Solr-off, gates, backup, reindex…).
- `migrator_jira_export` — epica + hops a CSV importable por Jira.
- `migrator_backup` — backup no destructivo del origen: dump de BD, copia del content store + manifiesto SHA-256 y snapshot de config (requiere aprobación).
- `migrator_steps_list` — catálogo de pasos de migración disponibles.
- `migrator_run_status` — checkpoints de un run (reanudable).

Escritura (marcadas `ask`; requieren aprobación humana; solo destino):
- `migrator_target` — prepara el destino (dry-run o ejecución).
- `migrator_run_steps` — ejecuta la composición de pasos que decide el agente (dry-run por defecto; `resume`).

## Pasos de migración (el agente compone, no un pipeline fijo)
`preflight-target`, `backup-source-db`, `copy-content`, `restore-target-db`, `schema-upgrade`, `reindex`,
`verify-target`. Cada paso es idempotente, se registra en `.migrator/checkpoints.jsonl` y respeta los
overrides `MIGRATOR_DB_DUMP_CMD`/`RESTORE_CMD`/`REINDEX_CMD`/`MIGRATOR_DST_PROVISION`.

## Flujo ensayo → producción
Una migración nunca se ejecuta directo en PROD: primero se ensaya en un **clon de producción o TEST**.
El ensayo es una **campaña con varios intentos**: ejecutas en PRE, falla un paso, restauras y **reanudas
desde ese punto** (`resumeFrom`); cada intento queda registrado.

1. `stage: clone|test` → ejecutar los pasos (`migrator_run_steps`) y registrar cada intento con
   `migrator_rehearsal_record` (outcome `ok|failed|aborted`, paso fallido y punto de reanudación).
   La campaña guarda el *fingerprint* del origen: versión, esquema PK/UNIQUE, replicación, nodos, tamaño.
2. `stage: prod` → `migrator_target --execute` / `migrator_run_steps` comprueban `migrator_environment_parity`:
   - sin ensayo validado → **bloquea**;
   - drift `BLOCKER` (versión distinta, esquema con defecto, CDC activo) → **bloquea**;
   - drift `WARN` (nodos/tamaño > 10%) → avisa.

La experiencia se guarda en `.migrator/experience.jsonl` (una campaña por proyecto+stage, con su historial
de intentos); complementa la memoria conversacional del arnés y permite reanudar sin repetir lo ya hecho.

## Seguridad (encapsulada en el arnés)
- `tools/pre-execute`: allow para read-only, `ask` para escritura, deny para tools desconocidas del plugin.
- `ctx.tools.guard()`: guard monotónico que bloquea cualquier escritura que apunte al origen.
- **Aprobación real** (`approval/request`): el plugin instala un *answerer* configurable por
  `MIGRATOR_APPROVAL`:
  - `deny` (defecto) — rechaza toda escritura (fail-closed);
  - `allowlist` — permite solo las tools de `MIGRATOR_APPROVAL_ALLOW` (coma-separadas);
  - `interactive` — pregunta por stdin si hay TTY; sin TTY (perfil web) delega en la UI del arnés;
  - `allow` — concede todo (solo entornos de confianza/CI).

  Sin answerer el arnés falla en cerrado. Verificado end-to-end: `rejected` con allowlist sin la tool y
  `allowed-once` + ejecución real del paso con la tool permitida.

  **Solo concesiones one-shot.** El vocabulario del arnés es cerrado (`allowed-once | rejected |
  cancelled | unavailable`) y `allowed-once` es la única concesión; no existe "permitir siempre". El
  plugin lo garantiza (`assertOneShot`) y audita cada decisión en `.migrator/approvals.jsonl`.
  La durabilidad por tool vive en la config (`allowlist`/`allow`), no en un grant de sesión.

  **Sin autorizaciones heredadas en cadena (con matices).** `allowed-once` es one-shot y está atado a
  la llamada, así que en `interactive`/`web` un subagente **no** se bloquea (aprobar ese borrado concreto
  es correcto). En cambio `allowlist`/`allow` aprueban un **nombre de tool**, no una acción, y un
  subagente heredaría esa concesión amplia: por eso ahí se rechazan las tools de **escritura** del
  migrador pedidas por agentes delegados (`parentAgent`/`meta.origin='subagent'`/`delegationDepth>0`).
  Las read-only nunca se bloquean, y las tools ajenas siempre se delegan.

## Datos de dominio (`data/`)
- `schema-references/<ver>/Schema-Reference-ALF.xml` (+ `-ACT.xml`): referencia oficial por versión.
- `upgrade-paths.yaml`: **matriz de rutas de upgrade y gates** (datos, no código).
- `estimation.yaml`: parámetros/umbrales del estimador.
- `strategy.yaml`: umbrales del selector de estrategia.
- `memory.yaml`: reparto de memoria del stack destino (Alfresco = fracción de la RAM disponible en el host/Docker, con suelo y techo).
- `recommendations.yaml`, `project.schema.json`, `projects/example.yaml`.

> El conocimiento vive en **datos y skills**, no hardcodeado. Cambiar la matriz de upgrade o los
> umbrales no requiere tocar código: se edita el YAML.

## dsh y el plugin (no duplicar)
dsh ya aporta el loop, la memoria de sesión, la aprobación y su UI, los presets de permisos, las skills,
las tools nativas (bash/fs/`ask_user`/todo/subagent/web…) y el registro de plugins por perfil. El plugin
solo añade **dominio** y no reimplementa nada de eso:
- Se registra como **bundle** del perfil (`package.json` → `dsh.bundle.patch` → `cordis.yml`) con
  `dsh plugin --profile <n> add <repo>`, o como overlay suelto con `dsh --patch ./cordis.yml`.
- La aprobación es un **answerer** del seam `dsh-user-approval` (que no trae answerer propio); en el perfil
  `web` responde la UI. El plugin solo impone la regla de dominio (las escrituras `migrator_*` requieren aprobación).
- Las skills usan el registro `dsh-skill` (contenido generado desde `data/`); el provider de ficheros de dsh es otra vía.
- `.migrator/*.jsonl` (checkpoints/experiencia) son artefactos de **dominio**, no memoria conversacional del arnés.

## Instalación y lanzamiento
```sh
./install.sh    # deps + build + registra el bundle en el perfil dsh + instala el comando `alfresco-dsh-horcas`
cp .env.example .env   # (install.sh lo crea si no existe) y rellena credenciales y modelo

alfresco-dsh-horcas "analiza en solo lectura la migracion de data/projects/example.yaml"   # headless
alfresco-dsh-horcas web [--port 8080] [--no-open]                                          # UI en el navegador
./alfresco-dsh-horcas "..."   # tambien funciona sin instalar, desde el repo
```
- `install.sh` deja **`alfresco-dsh-horcas`** como comando global (al estilo `opencode`/`codex`/`claude`):
  `npm link` si puede y, si no, un symlink en `~/.local/bin`.
- El comando carga `.env`, construye `dist/` si falta, mapea el modelo a `DEEPSEEK_*` y lanza dsh.
  Sin argumentos abre la **UI web**; `headless "<tarea>"` es no interactivo. Usa `dsh` del PATH o,
  si no, `npx @deepseek-ai/dsh`. Si el plugin está instalado en el perfil, lo carga como capa; si no,
  cae a `--patch ./cordis.yml`.
- Aprobación de escrituras: **`interactive`** por defecto en **web** (aprueba en la UI; sin TTY delega
  en ella) y **`deny`** (fail-closed) en headless. También `allowlist`/`allow` (CI).
- Requiere `dsh` y Node ≥ 20 (o `npx`). `DSH_PROFILE` cambia el perfil de dsh.

## Desarrollo
```sh
npm install
npm run typecheck
npm test          # unitarios (los live se omiten sin entorno)
npm run test:live # tests contra el origen real (requiere MIGRATOR_SRC_DB_*)
                  # el dry-run del pipeline exige MIGRATOR_LIVE_PIPELINE=true (no escribe nada)
npm run build
dsh --profile web --patch ./cordis.yml
```

Variables de entorno del origen: `MIGRATOR_SRC_DB_URL` (o `MIGRATOR_SRC_DB_HOST/PORT/NAME/USER/PASSWORD`),
`MIGRATOR_SRC_VERSION`. `MIGRATOR_DATA_DIR` sobreescribe el directorio `data/`.

Content store: en `contentStore` puedes declarar `path` (ruta del host) o `volume` (volumen Docker);
con `volume`, el plugin resuelve su mountpoint real con `docker volume inspect` en el host correspondiente
y trata `path` como subruta dentro del volumen. El origen (backup/copia) se ejecuta en el host local;
la escritura va al host destino por SSH.

Idioma: el agente responde en **español por defecto** (sección de system prompt configurable con
`MIGRATOR_LANG=es|en|pt|…`), manteniendo intactos los identificadores técnicos.

Avisos proactivos: `migrator_run_steps` avisa si es el **primer intento** (sin experiencia previa) o si
hay un intento previo fallido y conviene `resume=true`.

## Estado
- **Fase 1 (completa)**: tools read-only, seguridad (origen inmutable + aprobación) y datos de dominio.
- **Fase 2 (completa)**: ejecución en destino (provisión, backup, copia, restore, schema-upgrade, reindex)
  vía `migrator_run_steps` con aprobación y guardas, y verificación de paridad (`migrator_verify_target`).
- **Pendiente operativo**: ejecutar la campaña de ensayo end-to-end sobre el entorno real (ver flujo
  ensayo → producción) y validar la paridad antes del corte.

## Principio de diseño: hechos en el código, juicio en el agente
- **Tools = hechos**: parseo (`/proc/mounts`, `lsblk`, JDBC, hashes), igualdad demostrable, validación de
  schema, SQL read-only. Devuelven datos, no conclusiones.
- **Skills + LLM = juicio**: interpretación (¿es SAN/NAS?, ¿qué estrategia?, ¿es peligroso?, ¿qué falta
  para el corte?). El conocimiento vive en skills (`src/skills.ts`), no hardcodeado.
- **Guardas = código determinista**: origen inmutable, aprobación, y bloqueo **solo cuando es
  demostrable** (mismo export/device de content store).
- Cuando algo **no se puede saber desde el guest** (p.ej. el datastore de un disco virtual), la tool lo
  marca `requiresHumanConfirmation` y el agente **pregunta al humano** (`ask_user`) en vez de inventar.
