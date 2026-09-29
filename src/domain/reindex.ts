/**
 * Reindexacion del destino (E9). Los indices NUNCA se migran: se regeneran.
 *
 * - Resuelve la estrategia por version/motor:
 *   · Solr (CE < 26.2): delete/borrado de cores o tracking.
 *   · Search Enterprise (EE): Reindexing app one-shot (`reindexByIds`).
 *   · Search Community (CE >= 26.2, `elasticsearch`/`opensearch`): `alfresco-elasticsearch-batch-indexing`
 *     por SONDEO. NO indexa el historico: hay que SEMBRAR el cursor (watermark) y dejar `maxGapAge=0`
 *     hasta que alcance el presente.
 * - Genera/valida `reindex.prefixes-file.json` (namespace uri -> prefix) desde los modelos de contenido.
 * - Construye el comando de la Reindexing app y parsea `Total indexed documents:: N`.
 *
 * Fuentes: Hyland Search Community (batch-indexing 5.7.1; cursor `reindexByDate` en el indice de estado
 * `alfresco-reindex-state`; `alfresco.reindex.continuous.maxGapAge`); acs-deployment.
 */
import { readdir, readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { XMLParser } from 'fast-xml-parser';
import { atLeast, parseVersion } from './versions.js';

/** Componente mayor de una version (7.1.0 -> 7). */
const major = (version: string): number => parseVersion(version)[0] ?? 0;

export type ReindexKind = 'SOLR_DELETE' | 'SOLR_TRACKING' | 'REINDEXING_APP' | 'SEARCH_COMMUNITY';

export interface ReindexStrategy {
  kind: ReindexKind;
  tool: string;
  args: string[];
  online: boolean;
}

export interface ModelNamespace {
  uri: string;
  prefix: string;
}

/** Imagen del indexador de Search Community (indice por sondeo, con cursor/watermark). */
export const BATCH_INDEXER_IMAGE = 'alfresco/alfresco-elasticsearch-batch-indexing:5.7.1';
/** Indice de estado que guarda el cursor (oculto). */
export const DEFAULT_STATE_INDEX = 'alfresco-reindex-state';
/** Indice principal de busqueda. */
export const DEFAULT_MAIN_INDEX = 'alfresco';
/** Id del documento del cursor (watermark) dentro del indice de estado. */
export const WATERMARK_DOC_ID = 'reindexByDate-watermark';
export const DEFAULT_SEARCH_PORT = 9200;

const isSearchEnterprise = (engine: string): boolean =>
  ['OPENSEARCH', 'ELASTICSEARCH'].includes(engine.toUpperCase());

/** Search Community (indexador por sondeo con watermark) solo existe en CE 26.2+. */
export function isSearchCommunity(targetVersion: string, edition: string, engine: string): boolean {
  if (!isSearchEnterprise(engine)) return false;
  if (edition.toUpperCase() !== 'CE') return false;
  const [maj = 0, min = 0] = parseVersion(targetVersion);
  return maj > 26 || (maj === 26 && min >= 2);
}

export function resolveReindexStrategy(
  targetEngine: string,
  solrVersion: string,
  targetVersion: string,
  edition = 'CE',
): ReindexStrategy {
  if (!isSearchEnterprise(targetEngine)) {
    return major(solrVersion) <= 5
      ? { kind: 'SOLR_DELETE', tool: 'solr', args: ['stop', 'delete-cores', 'alfresco', 'archive', 'start'], online: false }
      : { kind: 'SOLR_TRACKING', tool: 'solr', args: ['reindex', 'alfresco', 'archive'], online: false };
  }
  // CE 26.2+: el indice se regenera con el batch-indexing por sondeo (Search Community), no con la app EE.
  if (isSearchCommunity(targetVersion, edition, targetEngine)) {
    return { kind: 'SEARCH_COMMUNITY', tool: BATCH_INDEXER_IMAGE, args: [], online: true };
  }
  return {
    kind: 'REINDEXING_APP',
    tool: `alfresco-elasticsearch-reindexing-${targetVersion}-app.jar`,
    args: ['--alfresco.reindex.jobName=reindexByIds'],
    online: true,
  };
}

/** Escanea ficheros de modelo XML y extrae los mapeos namespace (uri -> prefix). */
export function parseModelNamespaces(xml: string): ModelNamespace[] {
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', isArray: (name) => name === 'namespace' });
  const doc = parser.parse(xml) as { model?: { namespaces?: { namespace?: unknown } } };
  const found = new Map<string, string>();
  const list = doc.model?.namespaces?.namespace;
  for (const entry of Array.isArray(list) ? list : list ? [list] : []) {
    const uri = String((entry as Record<string, unknown>)['@_uri'] ?? '');
    const prefix = String((entry as Record<string, unknown>)['@_prefix'] ?? '');
    if (uri && prefix) found.set(uri, prefix);
  }
  return [...found.entries()].map(([uri, prefix]) => ({ uri, prefix }));
}

export async function scanModelsDirectory(modelsDir: string): Promise<ModelNamespace[]> {
  const found = new Map<string, string>();
  let files: string[];
  try {
    files = (await readdir(modelsDir)).filter((f) => f.endsWith('.xml'));
  } catch {
    return [];
  }
  for (const file of files) {
    try {
      for (const ns of parseModelNamespaces(await readFile(path.join(modelsDir, file), 'utf8'))) {
        found.set(ns.uri, ns.prefix);
      }
    } catch {
      // modelo ilegible: se ignora
    }
  }
  return [...found.entries()].map(([uri, prefix]) => ({ uri, prefix }));
}

/** Genera el JSON de prefixes (ordenado por uri). */
export function prefixesJson(namespaces: ModelNamespace[]): string {
  const sorted: Record<string, string> = {};
  for (const uri of [...namespaces.map((n) => n.uri)].sort()) {
    sorted[uri] = namespaces.find((n) => n.uri === uri)?.prefix ?? '';
  }
  return JSON.stringify(sorted, null, 2);
}

export async function writePrefixesFile(directory: string, namespaces: ModelNamespace[]): Promise<string> {
  const file = path.join(directory, 'reindex.prefixes-file.json');
  await mkdir(directory, { recursive: true });
  await writeFile(file, prefixesJson(namespaces), 'utf8');
  return file;
}

/** Namespaces (uri -> prefix) de un conjunto de modelos de contenido, ordenados por uri. */
export function prefixesFromModels(models: Array<{ namespaces: ModelNamespace[] }>): ModelNamespace[] {
  const found = new Map<string, string>();
  for (const model of models) for (const ns of model.namespaces) if (ns.uri && ns.prefix) found.set(ns.uri, ns.prefix);
  return [...found.entries()].map(([uri, prefix]) => ({ uri, prefix })).sort((a, b) => (a.uri < b.uri ? -1 : 1));
}

/**
 * Namespaces requeridos que FALTAN (o están con OTRO prefix) en el fichero del indexador. El fichero del
 * batch indexer REEMPLAZA el mapa embebido (no lo amplía): un namespace ausente deja nodos SIN indexar en
 * silencio, así que hay que comprobarlo contra los namespaces en uso de los modelos propios.
 */
export function missingPrefixes(required: ModelNamespace[], provided: ModelNamespace[]): ModelNamespace[] {
  const have = new Map(provided.map((n) => [n.uri, n.prefix]));
  return required.filter((n) => have.get(n.uri) !== n.prefix);
}

/**
 * Namespaces (uri -> prefix) de un `prefixes-file.json` del indexador. Acepta el formato que consume
 * `alfresco-elasticsearch-batch-indexing` (`{"prefixUriMap": {uri: prefix}}`) y el mapa PLANO
 * (`{uri: prefix}`) que producen otros generadores. Ignora claves que no son URI http(s).
 */
export function prefixMapFromJson(raw: unknown): ModelNamespace[] {
  if (!raw || typeof raw !== 'object') return [];
  const obj = raw as Record<string, unknown>;
  const map = (obj.prefixUriMap && typeof obj.prefixUriMap === 'object' ? obj.prefixUriMap : obj) as Record<string, unknown>;
  // Los namespaces propios pueden ser URIs cortas (`model.acme`), no solo http(s): no se filtra por esquema.
  return Object.entries(map)
    .filter(([uri]) => uri.length > 0)
    .map(([uri, prefix]) => ({ uri, prefix: String(prefix ?? '') }));
}

/** SQL (solo lectura) con el primer commit de la BD: semilla del cursor del batch indexer. */
export function minCommitTimeSql(): string {
  return 'SELECT min(commit_time_ms) FROM alf_transaction;';
}

/** Cuerpo del documento del cursor (watermark `reindexByDate`) del batch indexer de Search Community. */
export function watermarkSeedBody(minCommitTimeEpochMs: number): string {
  return JSON.stringify({ schemaVersion: 1, lastSuccessfulToTimeEpochMs: minCommitTimeEpochMs });
}

const shellQuote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;

export interface SearchCommunityOptions {
  /** Proyecto compose del DESTINO, para descubrir sus contenedores (si se conoce). */
  project?: string;
  /** Contenedor de PostgreSQL del DESTINO (si se conoce). */
  dbContainer?: string;
  dbUser: string;
  dbName: string;
  /** Password de la BD (si el contenedor no admite socket local sin ella). No se expone en la evidencia. */
  dbPassword?: string;
  /** Contenedor del motor de busqueda (si se conoce). */
  searchContainer?: string;
  /** URL del motor accesible desde el HOST DESTINO (si se conoce); si no, se usa `curl` dentro del contenedor. */
  searchUrl?: string;
  /** Nombre del indice de estado (cursor). */
  stateIndex?: string;
  port?: number;
}

/**
 * Script (idempotente, solo DESTINO) que SIEMBRA el cursor del batch indexer en el primer commit de la BD
 * para que indexe el backlog migrado. NO toca el historico por sí solo: el indexador, por defecto, arranca
 * en `now - overlap`; con este cursor + `maxGapAge=0` recorre desde el principio. Devuelve el watermark
 * leido de vuelta como prueba.
 */
export function searchCommunityReindexScript(o: SearchCommunityOptions): string {
  const state = o.stateIndex ?? DEFAULT_STATE_INDEX;
  const port = o.port ?? DEFAULT_SEARCH_PORT;
  const dbUser = shellQuote(o.dbUser);
  const dbName = shellQuote(o.dbName);
  const pgEnv = o.dbPassword ? `-e PGPASSWORD=${shellQuote(o.dbPassword)} ` : '';
  const projectFilter = o.project ? `--filter ${shellQuote(`label=com.docker.compose.project=${o.project}`)} ` : '';
  // Descubrimiento: 1) por SERVICIO compose (`search` / `postgres`, fiable); 2) por imagen, EXCLUYENDO el
  // batch indexer (su imagen `alfresco-elasticsearch-batch-indexing` casa con "elasticsearch" y no escucha en 9200).
  const byService = (service: string): string =>
    `$(docker ps ${projectFilter}--filter ${shellQuote(`label=com.docker.compose.service=${service}`)} --format '{{.Names}}' | head -n1)`;
  const byImage = (pattern: string): string =>
    `$(docker ps ${projectFilter}--format '{{.Names}}|{{.Image}}' | grep -Ei ${shellQuote(pattern)} | grep -Eiv 'batch-index' | head -n1 | cut -d'|' -f1)`;
  const findContainer = (service: string, pattern: string): string => `"${byService(service)}"; [ -n "$_C" ] || _C="${byImage(pattern)}"`;
  const search = o.searchContainer ? shellQuote(o.searchContainer) : `\${MIGRATOR_DST_SEARCH_CONTAINER:-}`;
  const db = o.dbContainer ? shellQuote(o.dbContainer) : `\${MIGRATOR_DST_PG_CONTAINER:-}`;
  const lines = [
    'set -e',
    `SEARCH=${search}`,
    `DB=${db}`,
    `if [ -z "$SEARCH" ]; then _C=${findContainer('search', 'opensearch|elasticsearch')}; SEARCH="$_C"; fi`,
    `if [ -z "$DB" ]; then _C=${findContainer('postgres', 'postgres')}; DB="$_C"; fi`,
    `[ -n "$SEARCH" ] || { echo "sin contenedor de busqueda (opensearch/elasticsearch) en el DESTINO"; exit 2; }`,
    `[ -n "$DB" ] || { echo "sin contenedor de PostgreSQL en el DESTINO (usa MIGRATOR_REINDEX_CMD para otra BD)"; exit 3; }`,
    `MIN="$(docker exec ${pgEnv}"$DB" psql -U ${dbUser} -d ${dbName} -tAc ${shellQuote(minCommitTimeSql())} | tr -d '[:space:]')"`,
    `case "$MIN" in ''|*[!0-9]*) echo "min(commit_time_ms) no valido: '$MIN'"; exit 4;; esac`,
  ];
  if (o.searchUrl) {
    lines.push(
      `CURL="curl -fsS"`,
      `BASE=${shellQuote(o.searchUrl.replace(/\/$/, ''))}`,
    );
  } else {
    lines.push(`CURL="docker exec $SEARCH curl -fsS"`, `BASE="http://localhost:${port}"`);
  }
  lines.push(
    `BODY="{\\"schemaVersion\\":1,\\"lastSuccessfulToTimeEpochMs\\":$MIN}"`,
    `$CURL -X PUT "$BASE/${state}/_doc/${WATERMARK_DOC_ID}" -H 'Content-Type: application/json' -d "$BODY" >/dev/null`,
    `echo "cursor ${state}/${WATERMARK_DOC_ID} sembrado en min(commit_time_ms)=$MIN"`,
    `$CURL "$BASE/${state}/_doc/${WATERMARK_DOC_ID}"`,
  );
  return lines.join('\n');
}

export interface ReindexParams {
  databaseUrl: string;
  databaseUser: string;
  searchUrl: string;
  brokerUrl: string;
  prefixesFile: string;
  repositoryUrl: string;
}

/** Comando de la Reindexing app (solo para estrategia REINDEXING_APP). */
export function reindexingAppCommand(strategy: ReindexStrategy, params: ReindexParams): string[] {
  if (strategy.kind !== 'REINDEXING_APP') {
    throw new Error('El comando de la Reindexing app solo aplica a REINDEXING_APP');
  }
  return [
    'java',
    '-jar',
    strategy.tool,
    ...strategy.args,
    `--spring.datasource.url=${params.databaseUrl}`,
    `--spring.datasource.username=${params.databaseUser}`,
    `--spring.elasticsearch.rest.uris=${params.searchUrl}`,
    `--spring.activemq.broker-url=${params.brokerUrl}`,
    `--alfresco.reindex.prefixes-file=${params.prefixesFile}`,
    `--alfresco.acceptedContentMediaTypesCache.baseurl=${params.repositoryUrl}`,
  ];
}

const TOTAL_INDEXED = /total indexed documents\s*::\s*(\d+)/i;

/** Total indexado del log, o -1 si aun no aparece la linea de resumen. */
export function parseTotalIndexed(log: string | undefined): number {
  const match = TOTAL_INDEXED.exec(log ?? '');
  return match ? Number.parseInt(match[1] as string, 10) : -1;
}

export function verifyIndexed(log: string | undefined, expectedIndexable: number): boolean {
  const indexed = parseTotalIndexed(log);
  return indexed >= 0 && indexed === expectedIndexable;
}

export { atLeast };
