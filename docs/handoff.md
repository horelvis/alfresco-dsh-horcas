# Handoff — dsh-alfresco-migrator

Fecha: 2026-09-27 · Último commit: `ab58803` (main, pusheado). Tests: **309 passed / 4 skipped**.
(Handoff anterior: 2026-09-20, commit `9fd57b4`; cubría 47 commits ya resueltos.)

## Objetivo
Ensayo real de migración **7.1.0 → 7.4 → 25.3 → 26.2** sobre el destino `alfresco-dst`, guiado por el
agente del plugin sobre el arnés fork.

## Repos y rutas
- Plugin: `<ruta-local>/dsh-alfresco-migrator` (git `horelvis/dsh-alfresco-migrator`, rama `main`).
- Arnés fork: `<ruta-local>/deepseek-harness` (`horelvis/deepseek-harness`, `master`).
- Workspace: `<workspace-del-proyecto>` (`<proyecto>.yaml`, `.env`, `.migrator/`).
- Origen: ACS 7.1.0 CE; contenedor Postgres del stack de origen;
  store `<ruta-del-origen>/alf-data/contentstore`.
- Destino: `http://192.0.2.11:8080/alfresco` — ACS **26.2.0 CE** (`alfresco-dst`).
- Backup existente: `.migrator/backup/` (dump BD + `contentstore/` ~1,9 GB + manifiesto SHA-256).

## Modelo LLM (efectivo)
- **Proveedor/modelo**: `opencode-go` / **`deepseek-v4.1-flash`** (id REAL de opencode Go).
- Se configura en la **config de modelos del arnés** (`~/.dsh/settings.yaml`), NO hardcodeado en el patch:
  ```yaml
  agent-default-model: { provider: opencode-go, model: deepseek-v4.1-flash }
  llm-pi-ai:
    providers:
      opencode-go:
        api: openai-completions
        baseURL: https://opencode.ai/zen/go/v1
        apiKeyEnv: OPENCODE_GO_API_KEY
        reasoning: off
        headers: { x-opencode-session: dsh-harness }
        models: [{ id: deepseek-v4.1-flash, name: DeepSeek-V41-Flash }]
  ```
- El gateway exige cabecera de sesión (`x-opencode-session` en `/chat/completions`); por eso va en `headers`.
- El lanzador exporta `OPENCODE_GO_API_KEY` desde `OPENAI_API_KEY`. `OPENAI_CHAT_OPTIONS_MODEL`/
  `DEEPSEEK_DEFAULT_MODEL` solo alimentan la búsqueda web. Para modelo local: otro provider en `llm-pi-ai`.

## Cómo lanzar
El lanzador carga, de menor a mayor prioridad: defaults internos → **defaults globales**
(`$ALFRESCO_DSH_HORCAS_ENV` o `~/.config/alfresco-dsh-horcas/env`) → **`.env` del workspace** → variables
exportadas al invocar (mandan siempre). Con `MIGRATOR_MODE`, `MIGRATOR_APPROVAL`, `DSH_BIN`, etc. en el `.env`
del workspace, basta:
```
cd <workspace-del-proyecto>
DSH_BIN="node <ruta-local>/deepseek-harness/apps/cli/lib/bin.js" alfresco-dsh-horcas web --no-open --port 8087
```
**`DSH_BIN` NO puede ir en el `.env`** (el arnés lo rechaza: solo lo fija el entorno que lo lanza). Expórtalo
al invocar o ponlo en el fichero de defaults globales del lanzador (no lo lee dsh). El perfil `web` enlaza el
plugin al repo con `patchReload: live`: cada arranque del arnés carga el `dist` recién compilado.
- **Guardrail solo-migración** (`MIGRATOR_GUARDRAIL=true`): permite lectura/orquestación; deniega `bash`/
  escritura de ficheros/web. Con `MIGRATOR_MODE=write`: toda escritura del migrator pasa por aprobación.
- **`/help`** (comando humano del arnés): muestra la ayuda de arranque del migrador sin depender del LLM.
- `~/.dsh/settings.yaml`: `ui-chat.transcriptView: compact`, `llm-deepseek` con `thinking: disabled` +
  `reasoningEffort: off`.

## Hecho desde el handoff anterior (47 commits, 21–27 sep)
- **Ensayo multi-hop guiado por el arnés** (`f8a2a29`): `provision-hop` → `backup-source-db` → `copy-content`
  → `restore-target-db` (solo primer hop) → `schema-upgrade` → `smoke-boot`; hop final + `reindex` →
  `verify-target`. La guarda de hops y el orden los **impone el plugin**, no el prompt.
- **`provision-hop` / `smoke-boot` / `schema-upgrade` automatizados**: provision levanta **solo
  infraestructura**; `schema-upgrade` arranca Alfresco sobre la BD ya migrada; `verify-target` comprueba
  readiness + que la raíz resuelve (evita el `root 404` de arrancar Alfresco antes del restore).
- **`target.composeFile`** (`65794c3`, `ab58803`): si el operador provee un compose del DESTINO, el migrator
  lo usa tal cual y **no genera ni escribe ninguno**; fusiona los secretos del stack en el `.env` junto a su
  compose sin pisar lo suyo, y rearranca la infra. Sin `dstDir` ni compose nuevo.
- **Reindex solo en la versión FINAL** (`1346681`): nunca por hop; impuesto en el plugin.
- **Seguridad / autoprotección** (`82fa0a0`): el agente no puede modificar, compilar ni versionar el plugin
  ni el arnés (shell y tools de fichero); los pasos fallidos no se esquivan. Corregido falso positivo de la
  guarda con `=>`/`->`/`>=` (`ce6576c`).
- **Auditoría en 3 niveles** (`1cd85cb`, `1aa12b8`):
  - **Nivel 0** — `migrator_audit` (`domain/audit.ts`): hechos deterministas desde el estado durable
    (`checkpoints`, `hops`, `experience`, `journal`, `evidence`, checklist) → `FAIL`/`WARN`/`INFO`;
    `.migrator/audit.jsonl`. Un FAIL bloquea declarar `validado=si`.
  - **Nivel 1** — revisor independiente con contexto fresco; el prompt empieza por `[[MIGRATOR-AUDITOR]]`
    (o teammate `auditor`), que **fuerza solo-lectura en el plugin** (enforcer determinista).
  - **Nivel 2** — puerta del arnés `harness/auditor-gate.mjs`: gate `tools/pre-execute` que **deniega**
    `migrator_report` y el `reindex` final si no hay auditoría reciente con 0 FAIL.
- **Memoria/continuidad**: `journal` durable + `migrator_resume` ("estado de la migración"), `migrator_help`,
  **lecciones COMPARTIDAS entre proyectos** (`migrator_lessons`/`_lesson_add` + inyección en system prompt),
  `session_search` en el patch del perfil.
- **Provisión endurecida**: tags exactos, rechazo de imágenes pre-release, login de registro (EE/quay.io),
  preflight de imágenes, proyecto compose válido (sin puntos), secretos del stack, `target.database.container`,
  rutas del HOST DESTINO (`dstDir`/`MIGRATOR_DST_DIR`), modo `manual` con comandos para sudo.
- **Datos de dominio**: Solr eliminado en 26.x (CE y EE); alcance de upgrade solo 7.x+; `7.1.0→7.4` SOPORTADO
  (lo que bloquea es saltarse 7.4).

## Pendiente
1. **Operativo (principal)**: ejecutar la **campaña de ensayo end-to-end** sobre el entorno real y validar la
   paridad antes del corte a PROD (ver "ensayo → producción" en `README.md`).
2. **Coherencia**: el `exp.conf.zip` colgante (binario ausente = **pérdida real**) → restaurar desde backup
   sobre copia y repetir FULL hasta que deje de ser FAIL.
3. **`db-version-migrate`** (candidato): `pg_upgrade` **o** restore lógico según la mayor de PG
   (hoy la BD se migra siempre por restore lógico `pg_restore`, cross-versión).
4. **Reconfigurar al dato final** (paso 4 del ciclo en `docs/upgrade-por-hop.md`): automático.
5. Modo `provision` que **parchee el tag de imagen** en el `compose.yaml` real (opt-in).
6. **Stack de la versión FINAL** y **JAR de modelos**: los aporta el humano en el YAML
   (`target.stack`, `target.modelsJar`); el migrator los valida/monta pero no los fabrica.

## Principio de diseño
**Hechos en el código, juicio en el agente**: tools = hechos (parseo, igualdad demostrable, SQL read-only);
skills + LLM = juicio; guardas = código determinista (origen inmutable, aprobación, autoprotección, hops,
auditoría). El origen **nunca** se modifica; el DESTINO se opera **solo** vía `migrator_run_steps`.
