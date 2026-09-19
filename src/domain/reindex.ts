/**
 * Reindexacion del destino (E9). Los indices NUNCA se migran: se regeneran.
 *
 * - Resuelve la estrategia por version/motor (Solr delete/tracking, Reindexing app de Search Enterprise).
 * - Genera `reindex.prefixes-file.json` (namespace uri -> prefix) desde los modelos de contenido.
 * - Construye el comando de la Reindexing app y parsea `Total indexed documents:: N`.
 *
 * Portado de DefaultReindexStrategyResolver/PrefixesFileGenerator/ReindexingApp/ModelNamespaceScanner.
 */
import { readdir, readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { XMLParser } from 'fast-xml-parser';
import { atLeast, parseVersion } from './versions.js';

/** Componente mayor de una version (7.1.0 -> 7). */
const major = (version: string): number => parseVersion(version)[0] ?? 0;

export type ReindexKind = 'SOLR_DELETE' | 'SOLR_TRACKING' | 'REINDEXING_APP';

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

const isSearchEnterprise = (engine: string): boolean =>
  ['OPENSEARCH', 'ELASTICSEARCH'].includes(engine.toUpperCase());

export function resolveReindexStrategy(targetEngine: string, solrVersion: string, targetVersion: string): ReindexStrategy {
  if (!isSearchEnterprise(targetEngine)) {
    return major(solrVersion) <= 5
      ? { kind: 'SOLR_DELETE', tool: 'solr', args: ['stop', 'delete-cores', 'alfresco', 'archive', 'start'], online: false }
      : { kind: 'SOLR_TRACKING', tool: 'solr', args: ['reindex', 'alfresco', 'archive'], online: false };
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
