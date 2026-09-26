# Upgrade físico por hop (procedimiento operativo)

**Alcance:** este migrador solo soporta ACS **7.x en adelante**. Las versiones previas (6.x y anteriores)
usan otra arquitectura (p. ej. Tomcat antiguo) y quedan **fuera de alcance**.

### Por qué 7.x+ y por qué 7.4 es obligatorio
- **Corte de arquitectura (Tomcat/Java).** La línea moderna cambia de stack:
  - 5.x/6.x: **Tomcat 8.5** y transformadores *legacy* **dentro del JVM** (retirados a partir de 6.2; en 7 ya
    no existen), con la transformación movida a *T-Engines*/Transform Service.
  - **7.0**: **Java 11 + Tomcat 9**.
  - **25.3**: **Tomcat 10** → salto `javax.*` → `jakarta.*` (Jakarta EE 9): **cambio incompatible** que obliga a
    recompilar la app.
  - **26.2**: **Tomcat 11**, Java 21/25.
  Este migrador asume la línea 7.x+; un origen 5.x/6.x exigiría otro modelo de despliegue y no está soportado.
- **7.4 es la puerta.** Hyland solo soporta el salto **directo a 25.3+/26.x desde 7.4 o superior** (último
  patch). Por eso la ruta es 7.1.0 → 7.4 → 25.3 → 26.2: **no se puede saltar 7.4**.

Fuentes: Hyland *Supported Platforms* ([7.0](https://docs.alfresco.com/content-services/7.0/support/),
[25.3](https://docs.hyland.com/r/Current/Alfresco-Supported-Platforms/olh1763030380749),
[26.2](https://docs.hyland.com/r/Current/Alfresco-Supported-Platforms/gbr1783492480042)), Hyland
*Upgrade paths* ([26.1](https://docs.hyland.com/r/Alfresco/Alfresco-Content-Services/26.1/Alfresco-Content-Services/Upgrade/Upgrade-Content-Services/Upgrade-paths)),
Apache *Tomcat Migration Guide* ([10.0](https://tomcat.apache.org/migration-10.html)).

Ruta obligatoria: **7.1.0 → 7.4 → 25.3 → 26.2** (no se salta de versión). En cada hop el DESTINO se sube a
la versión del salto, reutilizando **el mismo content store y la misma BBDD** (copiados a un *directorio de
versión*), y se deja que ACS aplique el **auto-update de esquema** al arrancar.

El harness **no** sustituye tu despliegue real (`alfresco-dst`): verifica la versión del hop (guarda de
hops, leída por REST), ejecuta/valida los pasos y registra el progreso. La provisión del stack es del
operador (o de un modo `provision` que parchee tu `compose.yaml`).

**Se restaura siempre desde un backup; el ORIGEN no se toca** (origen inmutable). Todo el trabajo ocurre
sobre copias en el DESTINO.

> Este documento es un **borrador de trabajo**: se ajustará durante el ensayo.

## Ciclo por hop

1. **Crear el directorio de la versión** destino (`<base>/<versión>/`) y **copiar ahí** el content store y
   la BBDD **partiendo del backup** (el **ORIGEN no se toca**: origen inmutable).
2. **Proveer la versión del salto**: imagen ACS del hop (`alfresco-content-repository-community:<versión>`)
   en el despliegue real, manteniendo el bind del content store y el volumen de la BBDD.
3. **Levantar y comprobar** que arranca OK (smoke test: readiness + log sin errores de esquema).
4. **Parar** y **reconfigurar** el stack apuntando al content store y la BBDD de la **versión final**
   (los datos copiados en el paso 1).
5. **Levantar** y dejar correr el **auto-update de esquema** nativo (Database schema version → `Started`).
6. **Check de comprobación** (readiness REST + conteo de nodos) y **siguiente versión**.

## PostgreSQL: versiones distintas entre hops

El salto de **versión mayor** de PostgreSQL (p. ej. 7.4 ≈ PG 13/14/15 → 26.2 = PG 17) no se puede hacer
"en caliente": hay que migrar la BBDD. Opciones, de más simple a más compleja:

| Vía | Cuándo | Herramienta |
|---|---|---|
| **Restore lógico** | Siempre que partas de un **backup lógico** (`pg_dump -Fc`) | `pg_restore` (lo que ya hace `restore-target-db`) o `psql` para dumps SQL. **Cross-versión soportado.** |
| **`pg_upgrade`** | Partes de un **data directory** físico y tienes los binarios de ambas mayores | `pg_upgrade` (`--link` o `--copy`); wrapper Debian/Ubuntu `pg_upgradecluster`. |
| **`pg_upgrade` en contenedor** | Igual, pero sin instalar binarios en el host | `pgautoupgrade/pgautoupgrade` (arranca y migra el volumen solo) o `tianon/docker-postgres-upgrade`. |
| **Migrador de datos** | Quieres reescribir esquema/datos a la vez | `pgloader` (cross-versión y desde otras BD). |
| **Globals** | Roles/tablespaces/permisos | `pg_dumpall --globals-only` + `psql` en el destino. |

En este proyecto la BBDD se migra **siempre desde backup** y **el ORIGEN nunca se toca** (origen
inmutable): la vía por defecto es **restore lógico** (`pg_restore`) de `db.dump` en la versión del hop, que
es cross-versión. **`pg_upgrade`/`pgautoupgrade` no hacen falta** salvo que quieras conservar el *volumen
físico del destino* entre mayores (nunca el data directory del origen).

## Mapeo con las tools del harness

| Paso del ciclo | Tool / mecanismo | Estado |
|---|---|---|
| 1. Directorio de versión + copia | — | **Pendiente** (hoy `copy-content` copia origen→destino directo). |
| 2. Proveer la versión del salto | `provision-hop` (en `migrator_run_steps`) | OK: para el stack anterior y levanta la infra del hop con `<dataDir>/compose/docker-compose-<hop>.yml`, conservando BD y content store. |
| 3. Smoke test | `smoke-boot` | OK: versión del DESTINO == hop, raíz resuelve y log sin errores de esquema (fail-closed). |
| 4. Reconfigurar al dato final | — | **Pendiente**. |
| 5. Auto-update de esquema | `schema-upgrade` | OK: arranca `alfresco` con el compose del hop y espera (`MIGRATOR_SCHEMA_UPGRADE_TIMEOUT_S`, defecto 1800 s); corta si el log muestra fallo de esquema. |
| 6. Check + siguiente | `verify-target`, `migrator_schema_check` | OK. |
| PG de versión distinta | `restore-target-db` (`pg_restore`) | Parcial: vía lógica; sin paso de `pg_upgrade`. |
| Guarda de hops | `domain/hops.ts` (`MIGRATOR_DST_BASE_URL`) | OK (fail-closed). |

## Pendiente de automatizar (candidatos)

- `db-version-migrate`: `pg_upgrade` **o** restore lógico según la mayor de PG.
- Modo `provision` que **parchee el tag de imagen** en el `compose.yaml` real (opt-in).
