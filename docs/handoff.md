# Handoff — dsh-alfresco-migrator

Fecha: 2026-09-20 · Último commit: `9fd57b4` (main, pusheado).

## Objetivo
Ensayo real de migración **7.1.0 → 7.4 → 25.3 → 26.2** sobre el destino `alfresco-dst`, guiado por el
agente del plugin sobre el arnés fork.

## Repos y rutas
- Plugin: `/Volumes/Macintosh SSD - Daten/Users/horelvis/git/dsh-alfresco-migrator` (git `horelvis/dsh-alfresco-migrator`, rama `main`).
- Arnés fork: `/Users/horelvis/git/deepseek-harness` (`horelvis/deepseek-harness`, `master`, `0.1.6-alpha.2`).
- Workspace: `/Users/horelvis/git/gadex-migration` (`gadex-7.1.0.yaml`, `.env`, `.migrator/`).
- Origen: gadex 7.1.0 CE; Postgres container `gadex-alfresco-docker-git-postgres-1`;
  store `/Users/horelvis/git/gadex-alfresco-docker-git/data/alf-repo-data/contentstore`.
- Destino: `http://192.168.100.51:8080/alfresco` — ACS **26.2.0 CE** (`alfresco-dst`).
- Backup existente: `.migrator/backup/` (dump BD + `contentstore/` ~1,9 GB + manifiesto SHA-256).

## Modelo LLM (efectivo)
- **Proveedor/modelo**: `deepseek-official` / **`deepseek-flash`** (nombre de catálogo **DeepSeek-V41-Flash**).
- **Endpoint**: `https://opencode.ai/zen/go/v1` (opencode Go; `DEEPSEEK_BASE_URL`). `DEEPSEEK_API_KEY` desde `.env`.
- Lo fija el bundle base (`agent-default-model`), NO `OPENAI_CHAT_OPTIONS_MODEL` del `.env` ni `DEEPSEEK_DEFAULT_MODEL`
  (ese solo lo usa el plugin de búsqueda web). Si se quiere modelo local: sección `llm-pi-ai` en `~/.dsh/settings.yaml`
  (`api: openai`, `baseURL` local) + override de `agent-default-model`.

## Cómo lanzar
```
cd /Users/horelvis/git/gadex-migration
DSH_BIN="node /Users/horelvis/git/deepseek-harness/apps/cli/lib/bin.js" \
MIGRATOR_MODE=write alfresco-dsh-horcas web --no-open --port 8087
```
- **Guardrail**: permite lectura, `bash`/`pwsh`, `write`/`edit` y orquestación; deniega solo la red.
- **Sandbox forzado `DSH_PERMISSION_MODE=read-only`**: toda escritura/borrado se bloquea y **escala a aprobación humana**.
- `~/.dsh/settings.yaml`: `ui-chat.transcriptView: compact`, `llm-deepseek` con `thinking: disabled` + `reasoningEffort: off`.

## Hecho hoy
- `reasoningEffort: off` verificado (sin CoT).
- **Conducta operativa** en system prompt (sin narración intermedia): `src/prompt.ts`.
- `migrator_dangling_explain`: dice explícitamente **"binario=AUSENTE"** (`present:false`/`missing:true`).
- **Discovery con fallback**: `discoverRest` prueba la API v1 y, si 404, `/api/discovery` (26.2 solo expone esta última).
- **Salida lossless JSON** en `run_steps`/`run_status` (el arnés rechazaba `undefined`).
- **Backup dry-run** detecta artefactos preexistentes (antes `CONFIG` siempre salía "a escribir").
- `bash`/`pwsh`/`write` permitidos + sandbox `read-only` (todo borrado pasa por humano).
- Tests: **182 passed / 4 skipped**.
- **Documentado el upgrade físico por hop** (`docs/upgrade-por-hop.md` + sección en `README.md`): ciclo
  directorio-de-versión → provisionar versión del salto → smoke → parar → reconfigurar al dato final →
  auto-update → check, **incluida la migración de versión mayor de PostgreSQL** (`pg_restore` lógico,
  `pg_upgrade`, `pgautoupgrade`). Pendiente de automatizar: `provision-hop`, `smoke-boot`,
  `db-version-migrate` y orquestar `schema-upgrade`.

## Contexto entre chats (session_search)
El agente puede leer sesiones previas del mismo workspace (`session_search`, `session_event_read`,
`session_trace`). `install.sh` lo configura en el patch del perfil (`~/.dsh/profiles/<perfil>/cordis.patch.yml`):
sobrescribe `session-query-sqlite` con `openAt: first-search` + índice durable, e inserta
`@deepseek-ai/dsh-tool-session-query` por ruta absoluta al fork (el perfil resuelve bundles desde el dsh
global). El guardrail ya permite esas tools. Pendiente: `journal` + `migrator_resume` (estado durable
"dónde estamos").

## Bloqueado / decisiones pendientes
1. El destino está en **26.2**, pero la **guarda de hops** exige el destino en **7.4** para el primer hop
   (bloquea el salto directo). → **Desplegar el destino en 7.4** antes del primer hop.
2. Decidir: (a) almacenamiento/datastore, (b) estrategia **C2/D2** vs **C5/D1**, (c) `MIGRATOR_DB_RESTORE_CMD`
   por `docker exec` (Postgres del destino no publicado).
3. **7.1.0 → 7.4 es SOPORTADO** (no requiere validacion del fabricante): lo que bloquea es **saltarse 7.4**
   (la cadena de hops lo impone). El caso con Hyland solo aplicaria a orígenes 6.x o anteriores.
4. Coherencia: `exp.conf.zip` colgante (binario ausente = **pérdida real**) → restaurar desde backup sobre
   copia y repetir FULL hasta que deje de ser FAIL.

## Nota del operador
El agente no detectaba el backup ya existente en `.migrator`: corregido (el dry-run ahora marca `CONFIG`
como `preexisting`; DB y content store ya se detectaban).
