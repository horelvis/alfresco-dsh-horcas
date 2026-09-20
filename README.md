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
cp .env.example .env            # EN EL WORKSPACE (directorio del proyecto); rellena origen/destino/modelo

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

## Guardrails de seguridad (todos)
La seguridad **no depende del prompt**: está impuesta en código determinista. Resumen, por mecanismo:

| # | Guardrail | Qué impone | Dónde | Config |
|---|---|---|---|---|
| 1 | **Origen inmutable** | El ORIGEN nunca se escribe | `infra/pg.ts` (SELECT-only), `security/policy.ts` (`guardReason`), `domain/guards.ts` (`requireDistinctTarget`) | — |
| 2 | **Solo-lectura por defecto** | Las tools de **escritura** del migrador se **deniegan** | `security/policy.ts` (`readOnly`) | `MIGRATOR_MODE=readonly\|write` |
| 3 | **Aprobación one-shot** | Escrituras (en `write`) requieren aprobación; fail-closed | `approval.ts` (`approval/request`) | `MIGRATOR_APPROVAL` |
| 4 | **Guardrail solo-migración** | Tools ajenas por capacidad: lectura/orquestación sí; ejecución/mutación/web no | `security/policy.ts` (`GUARDRAIL_ALLOW`) | `MIGRATOR_GUARDRAIL`, `MIGRATOR_GUARDRAIL_ALLOW` |
| 5 | **Rutas de versión estrictas** | Rechaza saltos `UNSUPPORTED`; avisa hops intermedios y `REQUIRES_VALIDATION` | `domain/upgrade-paths.ts` | — |
| 6 | **Guardas de almacenamiento (NAS/SAN)** | Mismo backing store → BLOCKER (aborta la copia); no demostrable → confirmación humana | `domain/mounts.ts`, `steps.ts` | `MIGRATOR_SKIP_MOUNT_GUARD` |
| 7 | **Ensayo → PROD** | PROD exige ensayo validado; drift `BLOCKER` bloquea | `tools/write.ts`, `tools/execution.ts`, `domain/experience.ts` | — |
| 8 | **Política de coherencia** | `FAIL_ON_DANGLING` bloquea; `WARN`/`REPAIR` no | `tools/coherence.ts`, `domain/coherence.ts` | `migration.coherence.policy` |
| 9 | **Reviewer LLM** | Anonimización reversible; ante duda **ABSTAIN** (nunca aprueba solo) | `domain/reviewer.ts`, `domain/privacy.ts` | `MIGRATOR_AI_ANONYMIZATION` |
| 10 | **Secretos** | Compose sin secretos embebidos; `.env` ignorado por git | `domain/provision.ts`, `.gitignore` | — |
| 11 | **Recuperación tras interrupción** | Nunca reintentar a ciegas un paso con efectos: verificar estado y `resume` | `domain/checkpoints.ts`, `tools/execution.ts` | `migrator_run_status`, `resume` |
| 12 | **Guarda de hops** | Ruta multi-hop: no se ejecuta si el DESTINO no está en la versión del hop que toca (verificado por REST, fail-closed) | `domain/hops.ts`, `tools/execution.ts` | `MIGRATOR_DST_BASE_URL` |

### 1. Origen inmutable
- Todo acceso a PostgreSQL pasa por `selectOnly()` (solo `SELECT`/`WITH`).
- Guard monotónico (`ctx.tools.guard`): bloquea cualquier tool de escritura que nombre el origen.
- `requireDistinctTarget`: si destino y origen comparten **BD** o **content store** → `BLOCKER` (se aborta).

### 2. Solo-lectura por defecto (`MIGRATOR_MODE`)
Por defecto `readonly`: `migrator_target`, `migrator_run_steps`, `migrator_backup`, `migrator_reindex`,
`migrator_provision`, `migrator_copy_content` y `migrator_wizard` devuelven **`deny`** (aunque el modelo
insista). Para el ensayo/cutover real: `MIGRATOR_MODE=write` (y entonces aplica la aprobación del punto 3).

### 3. Aprobación real (`approval/request`)
Answerer configurable por `MIGRATOR_APPROVAL` (solo relevante con `MIGRATOR_MODE=write`):
- `deny` (defecto) — rechaza toda escritura (fail-closed);
- `allowlist` — permite solo las tools de `MIGRATOR_APPROVAL_ALLOW` (coma-separadas);
- `interactive` — pregunta por stdin si hay TTY; sin TTY (perfil web) delega en la UI del arnés;
- `allow` — concede todo (solo entornos de confianza/CI).

Solo concesiones **one-shot** (vocabulario cerrado `allowed-once | rejected | cancelled | unavailable`;
no existe "permitir siempre"): lo garantiza `assertOneShot` y cada decisión se audita en
`.migrator/approvals.jsonl`. Sin answerer el arnés falla en cerrado.

**Sin autorizaciones heredadas (con matices).** `allowed-once` está atado a la llamada, así que en
`interactive`/`web` un subagente **no** se bloquea. En cambio `allowlist`/`allow` aprueban un **nombre de
tool**, y un subagente heredaría esa concesión amplia: por eso ahí se rechazan las tools de **escritura**
del migrador pedidas por agentes delegados (`parentAgent`/`meta.origin='subagent'`/`delegationDepth>0`).
Las read-only nunca se bloquean.

### 4. Guardrail solo-migración (`MIGRATOR_GUARDRAIL`)
Activo por defecto. Las tools **ajenas** al plugin se deciden por **capacidad**:
- **Permitidas**: lectura/inspección (`read`, `read_image`, `glob`, `grep`), orquestación/multiagente
  (`subagent`, `send_message`, `interrupt_agent`, `list_subagent_models`, `todo_write`, `skill`,
  `present`, `job_list`/`job_output`/`job_kill`, `create_goal`/`get_goal`/`update_goal`) y preguntas al
  humano (`ask_user_question`).
- **Denegadas**: ejecución y mutación (`bash`, `pwsh`, `write`, `edit`, `str_replace_editor`, `web_fetch`,
  `web_search`) y cualquier tool desconocida.

Ampliable con `MIGRATOR_GUARDRAIL_ALLOW=bash,read`; desactivable con `MIGRATOR_GUARDRAIL=false`.

### 5. Rutas de versión estrictas
`requireSupportedUpgradePath(from, to)` **lanza** si no hay ruta o si algún hop es `UNSUPPORTED` (nunca se
salta de versión); `upgradePathWarnings` avisa de los saltos intermedios obligatorios y de
`REQUIRES_VALIDATION`. Se aplica en `migrator_target`, `migrator_run_steps` y `migrator_provision`.

### 6. Guardas de almacenamiento (NAS/SAN)
`migrator_mount_check` y `copy-content` detectan mismo *backing store* (mismo export NFS/CIFS o mismo
LUN): **BLOCKER** y la copia **aborta**. Lo que no es demostrable desde el guest (discos virtuales/SAN)
se marca `requiresHumanConfirmation=true` y el agente **pregunta** (`ask_user_question`), no lo inventa.

### 7. Ensayo → PROD
`stage: prod` exige un **ensayo (clone/TEST) validado**; el drift respecto al ensayo con severidad
`BLOCKER` (versión distinta, esquema con defecto, CDC activo) **bloquea** la ejecución.

### 8. Política de coherencia
`migration.coherence.policy`: `FAIL_ON_DANGLING` (default) marca `blocked=true` con colgantes;
`WARN`/`REPAIR` permiten continuar dejándolo documentado.

### 9. Reviewer LLM
Los artefactos hacia el LLM se **anonimizan** de forma reversible (el mapeo nunca sale del host) y, si el
LLM falla o responde algo no parseable, el veredicto es **`ABSTAIN`** (nunca un "apruebo" implícito).

### 10. Secretos
El compose generado no embebe secretos (variables de entorno); `.env` está en `.gitignore`.

### 11. Recuperación tras interrupción
Si una llamada a tool se interrumpe (parada del turno, cierre/reinicio del servidor web), el arnés la
marca como *"outcome unknown"* y no cierra el turno. Para nuestras tools:
- **Read-only** (`migrator_coherence`, `migrator_assess`, `migrator_verify_target`…): reintentar es seguro.
- **Escritura/idempotentes** (`migrator_run_steps`, `copy-content`, `restore-target-db`, `reindex`…): **no
  reintentar a ciegas**. Primero `migrator_run_status` (checkpoints) y verificar el estado externo; luego
  continuar con `migrator_run_steps` y `resume=true` (omite los pasos ya `OK` en `.migrator/checkpoints.jsonl`).
- No reiniciar el servidor del perfil `web` con un turno en curso.

Las tools **read-only declaran `timeoutMs`** (15s–5min según coste) para que no cuelguen indefinidamente.
Las de **escritura no lo declaran** a propósito: cancelar un paso con efectos podría dejar un resultado
ambiguo ("outcome unknown"); en su lugar son **idempotentes + checkpointed** y se reanudan con `resume`.

### 12. Guarda de hops (ruta multi-hop)
Con una ruta de varios saltos (`7.1.0 → 7.4 → 25.3 → 26.2`), `migrator_run_steps` **no ejecuta** hasta que
el DESTINO esté en la versión del hop que toca. La versión del destino se **lee** del propio repositorio
(Discovery REST vía `MIGRATOR_DST_BASE_URL`), **no se declara**; si no se puede verificar, **falla en
cerrado**. El progreso por hop se registra en `.migrator/hops.jsonl`, así que no se puede saltar al hop
final sin pasar por los intermedios. Para una ruta de un solo hop la guarda no aplica.

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
las tools nativas (bash/fs/`ask_user_question`/todo/subagent/web…) y el registro de plugins por perfil. El plugin
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
- El comando carga el **`.env` del workspace actual** (el directorio desde el que se invoca; **no** el
  del repo del producto), construye `dist/` si falta, mapea el modelo a `DEEPSEEK_*` y lanza dsh.
  Sin argumentos abre la **UI web**; `headless "<tarea>"` es no interactivo. Usa `dsh` del PATH o,
  si no, `npx @deepseek-ai/dsh`. Si el plugin está instalado en el perfil, lo carga como capa; si no,
  cae a `--patch ./cordis.yml`.
- Aprobación de escrituras: **`interactive`** por defecto en **web** (aprueba en la UI; sin TTY delega
  en ella) y **`deny`** (fail-closed) en headless. También `allowlist`/`allow` (CI).
- **Solo-lectura determinista** por defecto (`MIGRATOR_MODE=readonly`): las tools de **escritura** del
  migrador se **deniegan** en el código (no depende de que el prompt diga "no escribas"). El ensayo/cutover
  real exige habilitarla explícitamente: `MIGRATOR_MODE=write` (+ la aprobación que corresponda).
- **Guardrail solo-migración** por defecto (`MIGRATOR_GUARDRAIL=true`): permite por **capacidad**
  lectura/inspección (`read`/`glob`/`grep`) y orquestación (`subagent`, `todo_write`, `skill`, jobs, goal,
  `ask_user_question`), y **deniega** ejecución/mutación (`bash`/`pwsh`, `write`/`edit`, `web_*`).
  Ampliar: `MIGRATOR_GUARDRAIL_ALLOW=bash,read`; uso general: `MIGRATOR_GUARDRAIL=false`.
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
