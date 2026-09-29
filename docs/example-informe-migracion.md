# Informe de migracion (EJEMPLO anonimizado) — acme-710

ACS CE 7.1.0 → CE 26.2 · stage **TEST** · generado 2026-09-29 07:26 (UTC) por alfresco-dsh-horcas

## 1. Resumen ejecutivo

- **Estado**: ruta completada; DESTINO en la version final (hop 26.2 · version=26.2.0 · root http=200 · share http=200).
- **Checklist**: 12 OK · 4 WARN · 1 PENDING · 0 FAIL (de 17).
- **Ensayo**: 4 intentos registrados (4 OK); validado=si; auditoria: 0 FAIL / 2 WARN.
- **Pendiente antes de PROD**: Backup del content store + manifest (SHA-256) (PENDING); Modulos/customizaciones del origen inventariados y revisados (WARN); Modelos de contenido: JAR del instalador validado y cargado en todos los hops (WARN); Coherencia DB <-> content store sin referencias colgantes (WARN); Coherencia tras la migracion (dangling=0) (WARN).

## 2. Alcance y entorno

| | Origen | Destino |
|---|---|---|
| Version | CE 7.1.0 | CE 26.2 |
| Base de datos | postgresql alfresco | postgresql alfresco |
| Content store | /opt/origen/acme-alfresco/data/alf-repo-data/contentstore | /srv/migrator/migracion-acme/alf-data/contentstore |
| Busqueda | solr | elasticsearch |
| Despliegue | — | compose en /srv/migrator/migracion-acme |

Estrategia: contenido **C2**, BD **D2**, indice **I2**; politica de coherencia **WARN**. El ORIGEN es inmutable (solo lectura).
Stack final: repositorio en http://192.0.2.11:8080/alfresco · Share en http://192.0.2.11:8081/share/ (SIN proxy: Share publica su propio puerto 8081).

## 3. Ruta de upgrade

| Hop | Clase | Completado |
|---|---|---|
| 7.1.0 → 7.4 | SUPPORTED | 2026-09-29 05:13 |
| 7.4 → 25.3 | SUPPORTED | 2026-09-29 05:17 |
| 25.3 → 26.2 | SUPPORTED | 2026-09-29 05:40 |

## 4. Ejecucion

### Run `acme-710-1790633442` (2026-09-28 22:10)

| Paso | Estado | Duracion | Detalle |
|---|---|---|---|
| preflight-target | OK | 3 s | docker=29.8.1 compose=5.5.1 acs=no detectado (docker NO es la version de ACS) |

### Run `acme-710-1790633658` (2026-09-28 22:15)

| Paso | Estado | Duracion | Detalle |
|---|---|---|---|
| provision-hop | OK | 1.5 min | hop 7.4: infraestructura levantada con /srv/migrator/migracion-acme/compose/docker-compose… |
| backup-source-db | FAILED | 0 s | sh: /home/migrator: File exists |
| backup-source-db | OK | 2 s | dump /home/migrator/.migrator/acme… |
| copy-content | OK | 3.1 min | Number of files: 5,089 (reg: 4,769, dir: 320) Number of created files: 241 (reg: 241) Num… |
| restore-target-db | OK | 3 s |  |
| schema-upgrade | FAILED | 19 s | alfresco 7.4 arrancado sobre la BD restaurada (discovery http=200); no arrancaron share: … |
| schema-upgrade | OK | 21 s | alfresco 7.4 arrancado sobre la BD restaurada (discovery http=200) |
| smoke-boot | OK | 1 s | hop 7.4 · version=7.4.2 · root http=200 |

### Run `acme-710-1790659018` (2026-09-29 05:17)

| Paso | Estado | Duracion | Detalle |
|---|---|---|---|
| provision-hop | OK | 39 s | hop 25.3: infraestructura levantada con /srv/migrator/migracion-acme/compose/docker-compos… |
| schema-upgrade | OK | 14 s | alfresco 25.3 arrancado sobre la BD restaurada (discovery http=200) |
| smoke-boot | OK | 1 s | hop 25.3 · version=25.3.0 · root http=200 |

### Run `acme-710-1790660294` (2026-09-29 05:40)

| Paso | Estado | Duracion | Detalle |
|---|---|---|---|
| provision-hop | OK | 2.0 min | hop 26.2: infraestructura levantada con /srv/migrator/migracion-acme/compose/docker-compos… |
| schema-upgrade | OK | 37 s | alfresco 26.2 arrancado sobre la BD restaurada (discovery http=200) · share http=200 · sh… |
| smoke-boot | OK | 1 s | hop 26.2 · version=26.2.0 · root http=200 · share http=200 |

### Run `acme-710-1790660557` (2026-09-29 05:42)

| Paso | Estado | Duracion | Detalle |
|---|---|---|---|
| verify-target | OK | 2 s | discovery http=200 · root http=200 |

### Run `acme-710-1790662911` (2026-09-29 06:21)

| Paso | Estado | Duracion | Detalle |
|---|---|---|---|
| reindex | FAILED | 1 s | curl: (7) Failed to connect to localhost port 9200: Connection refused |
| reindex | FAILED | 1 s | curl: (7) Failed to connect to localhost port 9200: Connection refused |
| reindex | FAILED | 1 s | curl: (7) Failed to connect to localhost port 9200 after 0 ms: Couldn't connect to server |
| reindex | OK | 1 s | cursor alfresco-reindex-state/reindexByDate-watermark sembrado en min(commit_time_ms)=175… |

## 5. Tiempos: estimado vs real (base para la ventana de PROD)

| Fase | Estimado | Real (ensayo) |
|---|---|---|
| PRE_STAGING | 90.0 min | 3.2 min |
| CUTOVER | 199.0 min | 5.3 min |
| POST_CUTOVER | 0 s | 3 s |

Ventana de corte estimada: **199.0 min** (confianza LOW, cuello SCHEMA_UPGRADE). Los tiempos reales del ensayo recalibran el modelo: extrapolar a PROD por volumen (nodos/bytes) y re-ejecutar migrator_estimate con el throughput medido.

### Politica de reindex para PROD

**POST_CUTOVER_ONLINE** (SEARCH_COMMUNITY): sin ventana de corte declarada: reindex online tras el corte. Metadatos ~0.0 h, contenido ~0.0 h (supuestos: medir con un piloto).

- Desplegar alfresco-elasticsearch-batch-indexing (Search Community) con index.subsystem.name=elasticsearch.
- SEMBRAR el watermark reindexByDate en MIN(alf_transaction.commit_time_ms) antes de arrancarlo (sin semilla empieza en "now" y NUNCA indexa lo migrado); alfresco.reindex.continuous.maxGapAge=0.
- Subir ALFRESCO_REINDEX_CONTINUOUS_MAXWINDOW (p.ej. 7d) para recorrer el historico; el delta posterior es continuo.
- Declarar el prefixes-file con los namespaces de los modelos propios (si falta uno, esos nodos no se indexan sin aviso).

## 6. Verificacion (checklist con evidencia)

| Fase | Comprobacion | Estado | Evidencia |
|---|---|---|---|
| PRE | Configuracion del proyecto valida | **OK** | acme-710 -> ACS 26.2 |
| PRE | Ruta de upgrade soportada | **OK** | 7.1.0->7.4[SUPPORTED] ; 7.4->25.3[SUPPORTED] ; 25.3->26.2[SUPPORTED] |
| PRE | Solr desmantelado (26.x: Solr no soportado, CE y EE) | **OK** | motor destino: elasticsearch |
| PRE | Backup de BD verificado/creado | **OK** | dump del origen creado y copia verificada en el DESTINO |
| PRE | Backup del content store + manifest (SHA-256) | **PENDING** | ejecutar migrator_backup |
| PRE | Esquema PostgreSQL con PK/unicidad completos (6 tablas criticas) | **OK** | 45 tablas vs referencia 7.1.0: PK/UNIQUE completos |
| PRE | Sin replicacion logica (CDC) activa en el origen | **OK** | sin replicacion logica activa |
| PRE | Modulos/customizaciones del origen inventariados y revisados | **WARN** | servicios: alfresco(repository, build propio), mysql(database, build propio), postgres(database), transform-c… |
| PRE | Modelos de contenido: JAR del instalador validado y cargado en todos … | **WARN** | acme-platform-models-2.0.jar (ocr:model.ocr, acme:model.acme, pmreg:model.reg, exp:model.exp) cubre 3/3 na… |
| PRE | Coherencia DB <-> content store sin referencias colgantes | **WARN** | refs=2381 dangling=1 orphans=2385 sizeMismatch=0 verdict=FAIL policy=WARN |
| PRE | Gates de breaking changes para 26.2: Java 21/Tomcat 10+; ActiveMQ 6.x… | **OK** | hops completados con smoke OK en cada version |
| PRE | Estimacion de ventana de corte (benchmark) | **OK** | estimacion calculada (3 hops) |
| PRE | Destino provisionado (o externo confirmado) | **OK** | destino provisionado por provision-hop |
| POST | Coherencia tras la migracion (dangling=0) | **WARN** | refs=2381 dangling=1 orphans=2385 sizeMismatch=0 verdict=FAIL policy=WARN |
| POST | Indice regenerado (Reindexing app; Total indexed documents) | **OK** | reindex ejecutado en la version final |
| POST | Conteos de nodos/refs y content store verificados (ACL manual) | **OK** | verdict=PASS: contentRefs 2381->2380, nodes 5760->5762, contentstore.files 4769->4768, contentstore.bytes 205… |
| POST | Origen retenido / rollback disponible (no destructivo) | **OK** | origen intacto hasta validar el destino |

## 7. Decisiones, bloqueos y aprobaciones

- 2026-09-28 22:11 · **plan** — Plan 3 hops en orden 7.1.0->7.4->25.3->26.2; hop 7.4 aprobado por el humano: provision-hop -> backup-source-db -> copy-content -> restore-target-db -> schema-upgrade -> smoke-boot; stack final repo+Share+transform publicHost=192.0.2.11, modelos acme-platform-models-2.0.jar; reindex solo en 26.2
- 2026-09-28 22:19 · **blocker** — Hop 7.4: provision-hop OK (infra 7.4 levantada, modelos validados); backup-source-db FALLA con 'sh: /home/migrator: File exists' porque MIGRATOR_DB_DUMP_CMD usa '> {out}' SIN citar y el workspace vive en una ruta con espacios - fix: citar {out} en el .env del workspace y reiniciar el migrador
- 2026-09-28 22:33 · **blocker** — Hop 7.4: dump OK (1.34MB), copy-content OK (4769 ficheros, 2057769122 bytes), restore-target-db OK y Alfresco 7.4.2 arrancado (discovery 200, REST 7.4.2); schema-upgrade FALLA al final con 'no such service: share' porque lateStackServicesFor arranca Share en hops intermedios aunque su compose no lo incluye
- 2026-09-29 05:15 · **approval** — Hop 7.4 CERRADO OK: provision-hop, backup-source-db (1.34MB), copy-content (4769 ficheros/2057769122 bytes), restore-target-db, schema-upgrade (discovery 200) y smoke-boot (version=7.4.2, root http=200); hops hechos=[7.4], pendiente=25.3, destino=7.4.2
- 2026-09-29 05:18 · **approval** — Hop 25.3 CERRADO OK: provision-hop (imagen 25.3.0), schema-upgrade (discovery 200) y smoke-boot (version=25.3.0, root http=200); hops hechos=[7.4,25.3], pendiente=26.2
- 2026-09-29 05:42 · **approval** — Hop 26.2 ARRANCADO OK: provision-hop (26.2.0 con stack final: share+transform+batch-indexer), schema-upgrade (discovery 200, share http=200) y smoke-boot (version=26.2.0, root 200, share 200); los 3 hops hechos, PERO verify-target FAIL (contentRefs 2381->2380, nodes 5760->5762, files 4769->4768, bytes -2848) y reindex pendiente de decision humana
- 2026-09-29 06:17 · **decision** — Paridad del hop final ACEPTADA con tolerancePct=0.1 (verdict=PASS): delta contentRefs -1 / nodes +2 / files -1 / bytes -2848 documentado (ref colgante exp.conf.zip ausente ya en el origen + nodos de sistema del destino); auditoria pasa a 0 FAIL / 5 WARN
- 2026-09-29 06:22 · **blocker** — Reindex 26.2: el paso falla con 'curl: (7) Failed to connect to localhost port 9200: Connection refused' pese a que el contenedor search esta Up; el probe del plugin (reindex.ts:213) hace `docker exec $SEARCH curl -fsS http://localhost:9200` y no alcanza el servicio dentro del contenedor
- 2026-09-29 07:20 · **decision** — Cierre del ensayo con reindex PENDIENTE: reintento tras reinicio sigue fallando con 'curl: (7) ... port 9200'; causa pendiente de confirmar (puerto publicado real != 9200 o contenedor search sin recrear). Se documenta como pendiente y se emite el informe final

## 8. Rollback

- El ORIGEN no se modifica en ningun paso: el rollback es volver a apuntar los clientes al origen.
- Backup no destructivo del origen: no registrado (ejecutar migrator_backup).

## 9. Pendiente y riesgos para PROD

- **PENDING** · Backup del content store + manifest (SHA-256): ejecutar migrator_backup
- **WARN** · Modulos/customizaciones del origen inventariados y revisados: servicios: alfresco(repository, build propio), mysql(database, build propio), postgres(database), transform-core-aio(transform), shared-file-store(transform), transform-ocr(transform, build propio), activemq(activemq), openldap(ldap), share(share, build propio), solr6(search, build propio), flowabl…
- **WARN** · Modelos de contenido: JAR del instalador validado y cargado en todos los hops: acme-platform-models-2.0.jar (ocr:model.ocr, acme:model.acme, pmreg:model.reg, exp:model.exp) cubre 3/3 namespaces propios en uso · avisos del JAR: propiedades de repositorio (alfresco-global.properties): alteran la configuracion del destino: alfresco/module/acme-platform-models/alfresco-global…
- **WARN** · Coherencia DB <-> content store sin referencias colgantes: refs=2381 dangling=1 orphans=2385 sizeMismatch=0 verdict=FAIL policy=WARN
- **WARN** · Coherencia tras la migracion (dangling=0): refs=2381 dangling=1 orphans=2385 sizeMismatch=0 verdict=FAIL policy=WARN
- **Bloqueo registrado** (2026-09-28 22:19): Hop 7.4: provision-hop OK (infra 7.4 levantada, modelos validados); backup-source-db FALLA con 'sh: /home/migrator: File exists' porque MIGRATOR_DB_DUMP_CMD usa '> {out}' SIN citar y el workspace vive en una ruta con espacios - fix: citar {out} en el .env del workspace y reiniciar el migrador
- **Bloqueo registrado** (2026-09-28 22:33): Hop 7.4: dump OK (1.34MB), copy-content OK (4769 ficheros, 2057769122 bytes), restore-target-db OK y Alfresco 7.4.2 arrancado (discovery 200, REST 7.4.2); schema-upgrade FALLA al final con 'no such service: share' porque lateStackServicesFor arranca Share en hops intermedios aunque su compose no lo…
- **Bloqueo registrado** (2026-09-29 06:22): Reindex 26.2: el paso falla con 'curl: (7) Failed to connect to localhost port 9200: Connection refused' pese a que el contenedor search esta Up; el probe del plugin (reindex.ts:213) hace `docker exec $SEARCH curl -fsS http://localhost:9200` y no alcanza el servicio dentro del contenedor

## 10. Auditoria (determinista, contra el estado durable)

Resultado: **0 FAIL / 2 WARN**. Verificado 2026-09-29 07:26.
- **WARN** · `CHECKLIST_PENDIENTE`: Backup del content store + manifest (SHA-256)
- **WARN** · `RUNS_SIN_INTENTO`: runs ejecutados sin intento en la campana: acme-710-1790633442, acme-710-1790660557
- **INFO** · `SHARE_URL`: Share accesible en http://192.0.2.11:8081/share/ (sin proxy)
