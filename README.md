# dsh-plugin-alfresco-migrator

Plugin de [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`) para migraciones de
**Alfresco Content Services**. El arnés aporta el **loop, la memoria de sesión y las herramientas**; este
plugin aporta el **dominio** (rutas de versión, esquemas de referencia, recomendaciones oficiales) y
**encapsula la seguridad** (el origen es inmutable; la escritura solo va al destino y con aprobación).

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
- `migrator_coherence` — coherencia DB↔content store (refs/dangling/orphans/verdict).
- `migrator_dangling_explain` — para cada colgante, nodo (vivo/versión/papelera), tipo, nombre y ruta.
- `migrator_strategy` — estrategia recomendada de contenido/BD/índice (C1–C5/D1–D2/I1–I2).
- `migrator_estimate` — estimación por fases (assessment/pre-staging/cutover/post), cuello y riesgos.
- `migrator_checklist` — checklist pre/post-cutover version-aware (Solr-off, gates, backup, reindex…).
- `migrator_jira_export` — epica + hops a CSV importable por Jira.
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
  - `interactive` — pregunta por stdin si hay TTY (si no, rechaza);
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
- `recommendations.yaml`, `project.schema.json`, `projects/example.yaml`.

## Desarrollo
```sh
npm install
npm run typecheck
npm test
npm run build
dsh --profile web --patch ./cordis.yml
```

Variables de entorno del origen: `MIGRATOR_SRC_DB_URL` (o `MIGRATOR_SRC_DB_HOST/PORT/NAME/USER/PASSWORD`),
`MIGRATOR_SRC_VERSION`. `MIGRATOR_DATA_DIR` sobreescribe el directorio `data/`.

Idioma: el agente responde en **español por defecto** (sección de system prompt configurable con
`MIGRATOR_LANG=es|en|pt|…`), manteniendo intactos los identificadores técnicos.

Avisos proactivos: `migrator_run_steps` avisa si es el **primer intento** (sin experiencia previa) o si
hay un intento previo fallido y conviene `resume=true`.

## Estado
Fase 1: tools read-only + seguridad + datos de dominio. Fase 2: ejecución del pipeline de destino
(provisión, copia, restore, reindex) con aprobación y guardas.
