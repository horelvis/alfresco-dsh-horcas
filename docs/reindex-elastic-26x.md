# Indice de busqueda en Alfresco 26.x (Search Community / Elasticsearch)

Referencia para migrar el **indice** del destino en 26.x. Los indices NUNCA se migran: se **regeneran**.
En 26.2 Community el motor deja de ser Solr y pasa a un OpenSearch/Elasticsearch estandar, indexado por
**sondeo** con un **cursor (watermark)**. Consecuencia clave: **el contenido preexistente NO se indexa solo**.

Fuente principal: *The Definitive Guide to Alfresco Search Community* (Hyland Connect, 19-ago-2026,
actualizada a 26.2 GA) y las notas de la release 26.2. Lo puesto aqui esta contrastado con la practica del
ensayo de este proyecto (`gadex 7.1.0 -> 7.4 -> 25.3 -> 26.2`).

## 1. Arquitectura

26.2 CE ("Alfresco Search Community") usa el subsistema `elasticsearch` del repositorio (el mismo de
Search Enterprise desde 7.1). Dos mitades que se despliegan y configuran por separado:

- **Query path** (dentro de Content Services): recibe la busqueda, la traduce, filtra permisos y consulta el
  cluster. **La app nunca habla con el cluster directamente.**
- **Batch-indexing app** (servicio aparte): lee de la BD del repositorio y escribe en el cluster.

Curiosidad de nombres: el producto se llama Search Community, pero todos los identificadores tecnicos
conservan el vocabulario antiguo. El subsistema es `elasticsearch`, el secreto compartido `solr.sharedSecret`,
el endpoint de extraccion de texto `/alfresco/service/api/solr/textContent` y el artefacto
`alfresco-elasticsearch-batch-indexing`. Decir "elasticsearch" no implica Elasticsearch el producto:
OpenSearch se configura con **las mismas** propiedades.

| Componente | Referencia |
|---|---|
| Repositorio | `alfresco/alfresco-content-repository-community:26.2.0` |
| Batch indexer | `alfresco/alfresco-elasticsearch-batch-indexing:5.7.1` |
| Transform Core (AIO) | `alfresco/alfresco-transform-core-aio:5.4.3` |
| Search engine | `opensearchproject/opensearch:2.11.1` **o** `docker.elastic.co/elasticsearch/elasticsearch:8.17.x` |
| Java | 17 |
| BD | PostgreSQL (driver incluido); MySQL/MariaDB metiendo el driver en `/opt/db-drivers` (montado `:ro`) |

El cluster **no lleva plugin de Alfresco**: stock OpenSearch/Elasticsearch, por lo que un servicio gestionado
es viable.

## 2. Los indices

- **`alfresco`** (principal): metadatos, contenido y path. Es el que consulta Content Services.
- **`alfresco-reindex-state`** (cursor/watermark, oculto): guarda **una** posicion de indexado.
- **`alfresco-reindex-dead-letter`** (fallos, oculto): items que no se pudieron indexar. **Recuperacion manual**
  (no hay endpoint de reintento): se corrige la causa y un ciclo posterior reindexa.
- `elasticsearch.archive.indexName` (`alfresco-archive`): **nada lo escribe ni lo crea** en 26.2 (el
  indexador no tiene nocion de el). Buscar "deleted-nodes" da error o resultados vacios enganosos. El borrado
  del indice principal SI es correcto (un nodo a la papelera sale de `alfresco` en un ciclo).

"Oculto" no es control de acceso (`index.hidden: true`): hay que usar permisos del cluster.

```
GET _cat/indices/alfresco*?v&s=index&expand_wildcards=all   # los tres
GET alfresco*/_settings?expand_wildcards=all&filter_path=**.hidden
```

## 3. El ciclo de sondeo (lo que sustituye a los trackers de Solr)

`ContinuousReindexingService`, cada `pollingInterval` (**30 s** por defecto):

- **El cursor solo avanza en exito.** Un ciclo fallido deja el watermark donde estaba y el siguiente
  reintenta la misma ventana.
- **La ventana solapa** `overlap` (10 min) hacia atras: un cambio en el borde no se pierde.
- **Metadata, content y path son independientes**: un fallo de transformacion de contenido no tira el ciclo.
- **En el primer arranque SIN cursor, empieza en `now - overlap`.** Este es el defecto mas importante:
  **un indexador nuevo sobre un repositorio con anos de historia indexa los ultimos 10 minutos y se da por
  al dia.**

Propiedades (prefijo `alfresco.reindex.continuous.`):

| Propiedad | Defecto | Nota |
|---|---|---|
| `pollingInterval` | `30s` | menor = mas fresco y mas carga |
| `maxWindow` | `30m` | tope de historia por ciclo; **subir** para la carga inicial (p.ej. `7d`) |
| `overlap` | `10m` | margen de seguridad; **no** poner 0 |
| `maxGapAge` | `24h` | **frontera de perdida de datos** (ver abajo) |
| `autoStart` | `true` | `false` para desplegar sin indexar |
| `autoCreateStateIndex` | `true` | `false` = **negarse a arrancar** si el cursor desaparece (evita rescan silencioso) |
| `bootstrapFromAlfrescoIndex` | `true` | sin cursor, lo siembra desde el ultimo cambio del indice principal |

> **`maxGapAge` es una frontera de perdida de datos.** Si el indexador ha estado caido mas de `maxGapAge`,
> **no** se pone al dia: salta a `now - maxGapAge`, loguea un warning y **lo saltado nunca se indexa**. Nada
> falla y el indice "parece sano". Para un reindex historico completo hay que ponerlo a **`0`**.

Job/rendimiento: `jobName=reindexByDate`, `batchSize=1000`, `pagesize=1000`, `concurrentProcessors=10`,
`metadata/content/pathIndexingEnabled=true`, `skipLimit=100`. La **extraccion de contenido** (Transform) es el
cuello de botella, no el indexado. `content.transform.writeConcurrency=16` se multiplica por
`concurrentProcessors`: ese producto es la concurrencia real contra el repositorio/transform.

## 4. Modelos propios y el `prefixes-file` (silencioso y peligroso)

El repositorio traduce URI de namespace -> prefix con su `NamespaceService`; el indexador **no puede** (lee la
BD por JDBC) y usa un fichero estatico `alfresco.reindex.prefixes-file`
(`classpath:reindex.prefixes-file.json`, 60 namespaces de Alfresco). Si un namespace propio falta:

- un nodo cuyo **tipo** es de un modelo propio **no se indexa** (no hay documento y el dead-letter queda
  vacio: cuenta como filtrado, `filterCount` sube mientras `readCount`/`writeCount` parecen sanos);
- un `cm:content` que solo **lleva** un aspecto propio se indexa **sin** las propiedades del aspecto.

Solo se ve como `ERROR` en el log del indexador. El fichero **reemplaza** el mapa embebido (no lo amplia), asi
que tiene que ser **completo**; pasar una sola entrada por `-DprefixUriMap[uri]=prefix` rompe igual (el system
property tiene precedencia sobre todo el mapa). Se genera desde el repositorio con el addon Apache-2.0
`AlfrescoLabs/model-ns-prefix-mapping` (WebScript read-only `/alfresco/s/model/ns-prefix-map`), y se comprueba
con `check-prefix-map.sh` (exit 0 = completo, 1 = falta/mal prefix, 2 = no se pudo comprobar). Debe ir por
`JAVA_OPTS` (`-Dalfresco.reindex.prefixes-file=file:/config/prefixes.json`), no como variable de entorno
(el `@PropertySource` se resuelve antes del relaxed binding).

> Corrector no revisa lo ya pasado (camina hacia delante por `commit_time_ms`): si estaba mal, hay que
> **resembrar el cursor y reindexar desde el principio** (o tocar los nodos para que vuelvan a la ventana).

## 5. Reindex completo (procedimiento manual)

El orden no es arbitrario: **el indice y su mapping los crea Content Services** (`createIndexIfNotExists` y
el `ContentModelSynchronizer` viven en el subsistema `elasticsearch` del repositorio), asi que el subsistema
debe estar activo **antes** de que el indexador tenga donde escribir. Desde ahi las busquedas se sirven de un
indice aun incompleto: o se hace en ventana, o se mantiene Solr como rollback.

1. **`ALFRESCO_REINDEX_CONTINUOUS_MAXGAPAGE=0`** (si no, el cursor historico se descarta en el primer ciclo).
2. **Sembrar el cursor** en el primer `commit_time_ms` de la BD:
   ```sh
   # MIN(alf_transaction.commit_time_ms) no una fecha fija: el catch-up recorre el CALENDARIO,
   # un maxWindow por ciclo aunque la ventana no tenga cambios.
   curl -X PUT "$OS/alfresco-reindex-state/_doc/reindexByDate-watermark" \
     -H 'Content-Type: application/json' \
     -d '{"schemaVersion":1,"lastSuccessfulToTimeEpochMs":<MIN>}'
   ```
3. Subir `continuous.maxWindow` (p.ej. `7d`) y, si procede, `batchSize`/`concurrentProcessors`.
4. **Verificar** (las cuatro):
   1. el cursor alcanza el presente (`lastSuccessfulToTimeEpochMs` deja de ir por detras);
   2. estan los **tres** tipos (metadata, content, path);
   3. el dead-letter revisado;
   4. busquedas representativas por **Content Services** (no por el cluster).
5. Volver a estado estacionario: `maxGapAge=24h`, `maxWindow=30m`; y solo entonces parar Solr.

Comandos utiles:

```sh
OS=http://localhost:9200
curl -s "$OS/alfresco-reindex-state/_doc/reindexByDate-watermark" | python3 -m json.tool
curl -s "$OS/alfresco/_count"
curl -s "$OS/alfresco-reindex-dead-letter/_search?size=20&expand_wildcards=all"
```

Campos del watermark: `lastSuccessfulFromTimeEpochMs`, `lastSuccessfulToTimeEpochMs`, `lastRunStatus`,
`lastRunReadCount`, `lastRunWriteCount`, `lastRunSkipCount`, `updatedAt`.

## 6. Monitorizacion

- **Lo mejor para vigilar es el cursor** (`lastSuccessfulToTimeEpochMs` acercandose al presente). Si se
  estanca, esa distancia es el lag.
- Actuator: `/actuator/health/liveness` (incluye `continuousReindexingMonitor` con `stuckThreshold`, defecto
  `10m`), `/actuator/prometheus`. Ojo con la cardinalidad: **cada ciclo es un job nuevo** (~2.880 `jobId`/dia);
  agregar, no agrupar por `jobId`.
- Logs: `reindexByDate cycle` y, mientras hay backlog, `[chunked gap recovery - more chunks pending]`.
- Spring Batch usa HSQLDB en memoria: el historial de jobs **no sobrevive** al reinicio (el progreso si, en el
  cursor). Reiniciar el indexador periodicamente es guia oficial.

## 7. Comportamiento de consultas (resumen de riesgo)

AFTS/Lucene/CMIS funcionan, pero cambia el juego de **pseudo-campos** y, sobre todo, el comportamiento ante
uno no soportado: **no falla, se DESCARTA en silencio** (WARN en el log del repositorio y la consulta sigue sin
esa condicion -> puede **ampliar** el resultado, no estrecharlo). Hay que **probar en diferencial** (baseline
vs supuestamente mas estrecha; si los conteos coinciden, se cayo la restriccion). Campos soportados: `TYPE`,
`ASPECT`, `CLASS`, `PATH`, `ANCESTOR`, `PARENT`, `TEXT`, `ALL`, `ID`, `OWNER`, `READER`, `DENIED`, `TAG`,
`SITE`... Silenciosamente ignorados: `DBID`, `TX`, `TXID`, `TXCOMMITTIME`, `PNAME`, `QNAME`, `FINGERPRINT`,
etc. `xpath`, `index-sql` e `index-alfresco` no existen. Grep del log:
`Ignoring query condition` / `Ignorning sort on field` (asi, con la errata).

## 8. Como lo hace este migrator

**El stack generado del hop FINAL (CE 26.2+, `elasticsearch`/`opensearch`) ya incluye lo necesario**:

- Repositorio: en `alfresco-global.properties` se activa `index.subsystem.name=elasticsearch`,
  `elasticsearch.host=search`/`port=9200`, `elasticsearch.createIndexIfNotExists=true`,
  `solr.secureComms=secret` y `solr.sharedSecret=<SEARCH_SHARED_SECRET>` (secreto del stack, generado una vez).
- Servicio **`batch-indexer`** (`alfresco-elasticsearch-batch-indexing:5.7.1`) con datasource, URI de
  Elasticsearch, `ALFRESCO_ACS_URL`, el secreto compartido, **`maxGapAge=0`** y `maxWindow=7d` para la carga
  inicial. Arranca en `schema-upgrade`, **despues** de que el repositorio responda (crea el indice y su
  mapping). Con `target.stack.transform: true` indexa **contenido** (via transform-core-aio); sin transform,
  se indexan solo metadatos y path (`ALFRESCO_REINDEX_CONTENTINDEXINGENABLED=false`).
- Si se aporta `MIGRATOR_REINDEX_PREFIXES_FILE` (local), `provision-hop` lo copia al destino y lo monta en el
  indexer (`/config/prefixes.json`).

`src/domain/reindex.ts` resuelve la estrategia por motor/edicion/version:

| Escenario | Estrategia | Accion del paso `reindex` |
|---|---|---|
| Solr (CE < 26.2) | `SOLR_DELETE` / `SOLR_TRACKING` | requiere `MIGRATOR_REINDEX_CMD` |
| Search Enterprise (EE) | `REINDEXING_APP` | requiere `MIGRATOR_REINDEX_CMD` (app one-shot `reindexByIds`) |
| **Search Community (CE 26.2+, `elasticsearch`/`opensearch`)** | `SEARCH_COMMUNITY` | **siembra el cursor** (watermark) y valida el prefix-map |

Para Search Community el paso `reindex` (solo en la version **FINAL**) ejecuta en el DESTINO:

1. **Valida el prefix-map** si se define `MIGRATOR_REINDEX_PREFIXES_FILE` contra los namespaces de
   `target.modelsJar`: si falta alguno, **bloquea** (evita indexar perdiendo nodos en silencio).
2. **Siembra el watermark** en `MIN(alf_transaction.commit_time_ms)` del indice de estado. Descubre los
   contenedores por imagen (`opensearch|elasticsearch`, `postgres`) o usa
   `MIGRATOR_DST_SEARCH_CONTAINER`/`MIGRATOR_DST_SEARCH_URL` y `MIGRATOR_DST_PG_CONTAINER`.
3. Devuelve el watermark leido como prueba y recuerda que **`maxGapAge=0`** debe seguir activo hasta que el
   cursor alcance el presente.

Variables de entorno (todas opcionales):

| Variable | Uso |
|---|---|
| `MIGRATOR_DST_SEARCH_URL` | URL del motor alcanzable desde el host DESTINO (si no, `docker exec` dentro del contenedor) |
| `MIGRATOR_DST_SEARCH_CONTAINER` | contenedor del motor (si no, se autodetecta por imagen) |
| `MIGRATOR_DST_PG_CONTAINER` | contenedor de PostgreSQL (si no, `target.database.container` o autodeteccion) |
| `MIGRATOR_REINDEX_STATE_INDEX` | indice de estado (defecto `alfresco-reindex-state`) |
| `MIGRATOR_REINDEX_PREFIXES_FILE` | `prefixes-file.json` completo, para VALIDARLO |
| `MIGRATOR_REINDEX_CMD` | anula todo lo anterior y ejecuta el comando dado (placeholders `{prefixesFile}`/`{dbUrl}`) |

> **No hay atajo.** Con `target.composeFile` (compose del operador) el `maxGapAge`/`prefixes-file` los fija el
> operador en su stack; el migrator siembra el cursor y valida el mapa, pero no reescribe su despliegue.
> El ensayo `gadex` demostro el caso peligroso: sin sembrar el cursor, el backlog migrado (dump) **nunca** entra
> en el indice aunque el repositorio arranque sano y la paridad de datos sea PASS.
