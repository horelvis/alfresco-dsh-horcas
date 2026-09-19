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

Escritura (marcadas `ask`; requieren aprobación humana; solo destino):
- `migrator_target` — prepara el destino. Con `execute=true` en `stage: prod` exige un ensayo validado y sin drift de bloqueo.

## Flujo ensayo → producción
Una migración nunca se ejecuta directo en PROD: primero se ensaya en un **clon de producción o TEST**.

1. `stage: clone|test` → ejecutar la migración de prueba y `migrator_rehearsal_record` (guarda el
   *fingerprint* del origen: versión, esquema PK/UNIQUE, replicación, nodos, tamaño de BD).
2. `stage: prod` → `migrator_target --execute` comprueba `migrator_environment_parity`:
   - sin ensayo validado → **bloquea**;
   - drift `BLOCKER` (versión distinta, esquema con defecto, CDC activo) → **bloquea**;
   - drift `WARN` (nodos/tamaño > 10%) → avisa.

La experiencia se guarda en `.migrator/experience.jsonl` (`MIGRATOR_STATE`), estructurada y consultable
en cualquier sesión futura; complementa la memoria conversacional del arnés.

## Seguridad (encapsulada en el arnés)
- `tools/pre-execute`: allow para read-only, `ask` para escritura, deny para tools desconocidas del plugin.
- `ctx.tools.guard()`: guard monotónico que bloquea cualquier escritura que apunte al origen.

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

## Estado
Fase 1: tools read-only + seguridad + datos de dominio. Fase 2: ejecución del pipeline de destino
(provisión, copia, restore, reindex) con aprobación y guardas.
