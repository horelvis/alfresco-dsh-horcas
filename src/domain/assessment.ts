/**
 * Assessment (inventario) del ORIGEN desde la fuente de verdad:
 * - version/edicion por el Discovery REST de ACS;
 * - nodos/auditoria/versiones/tamano de BD por JDBC READ-ONLY;
 * - ficheros/tamano/tamano maximo por el content store FS.
 *
 * NUNCA se consultan los indices de busqueda (Solr/Search Enterprise): son derivados y se regeneran.
 */
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { connectSource, queryRows, sourceDbConfigFromEnv, type SourceDbConfig } from '../infra/pg.js';
import type { ProjectConfig } from './project-config.js';

export interface Assessment {
  version: string;
  edition: string;
  nodes: number;
  audit: number;
  versions: number;
  dbSizeBytes: number;
  fileCount: number;
  contentSizeBytes: number;
  maxFileBytes: number;
  detected: { rest: boolean; jdbc: boolean; store: boolean };
  notes: string[];
}

const sizeSql = (engine: string | undefined): string | null => {
  switch ((engine ?? '').toLowerCase()) {
    case 'postgresql':
      return 'SELECT pg_database_size(current_database())';
    default:
      return null;
  }
};

/**
 * Discovery REST: version/edicion del repositorio. Prueba la API v1 (`/api/-default-/public/...`) y,
 * si no responde, el web script clasico (`/api/discovery`), que devuelve el mismo `entry.repository`
 * (con la version como cadena). Distintas versiones/ediciones exponen una u otra, asi que se intentan
 * en orden y se devuelve la primera que conteste.
 */
export async function discoverRest(
  baseUrl: string,
  user?: string,
  password?: string,
): Promise<{ version: string; edition: string } | undefined> {
  const root = baseUrl.replace(/\/+$/, '');
  const base = root.endsWith('/api') ? root : `${root}/api`;
  const candidates = [`${base}/-default-/public/alfresco/versions/1/discovery`, `${base}/discovery`];
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (user && password) {
    headers.Authorization = 'Basic ' + Buffer.from(`${user}:${password}`).toString('base64');
  }
  for (const url of candidates) {
    try {
      const response = await fetch(url, { headers, signal: AbortSignal.timeout(20_000) });
      if (!response.ok) continue;
      const body = (await response.json()) as {
        entry?: { repository?: { version?: { major?: number | string; minor?: number | string; patch?: number | string }; edition?: string } };
      };
      const repository = body.entry?.repository;
      const version = repository?.version;
      if (!version) continue;
      const label = `${version.major ?? 0}.${version.minor ?? 0}.${version.patch ?? 0}`;
      const edition = (repository?.edition ?? 'Community').toLowerCase() === 'enterprise' ? 'EE' : 'CE';
      return { version: label, edition };
    } catch {
      // endpoint no disponible: se prueba el siguiente
    }
  }
  return undefined;
}

export async function scanStore(root: string): Promise<{ files: number; bytes: number; maxBytes: number }> {
  let files = 0;
  let bytes = 0;
  let maxBytes = 0;
  async function walk(current: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) {
        try {
          const size = (await stat(full)).size;
          files++;
          bytes += size;
          if (size > maxBytes) maxBytes = size;
        } catch {
          // fichero desaparecido/ilegible: se ignora
        }
      }
    }
  }
  await walk(root);
  return { files, bytes, maxBytes };
}

export interface AssessmentOptions {
  baseUrl?: string;
  restUser?: string;
  restPassword?: string;
  dbConfig?: SourceDbConfig;
  /** Para tests: inyectar un contador JDBC en vez de conectar. */
  jdbc?: (dbConfig: SourceDbConfig, engine: string) => Promise<{ nodes: number; audit: number; versions: number; dbSizeBytes: number }>;
}

export async function assessSource(project: ProjectConfig, options: AssessmentOptions = {}): Promise<Assessment> {
  const notes: string[] = [];
  let version = project.source.version;
  let edition = project.source.edition ?? 'CE';
  let restOk = false;
  let jdbcOk = false;
  let storeOk = false;

  const baseUrl = options.baseUrl ?? project.source.baseUrl;
  if (baseUrl) {
    const discovery = await discoverRest(baseUrl, options.restUser, options.restPassword);
    if (discovery) {
      version = discovery.version;
      edition = discovery.edition;
      restOk = true;
    } else {
      notes.push('Discovery REST no disponible; se usa la version de la configuracion');
    }
  }

  let nodes = 0;
  let audit = 0;
  let versions = 0;
  let dbSizeBytes = 0;
  const db = project.source.database;
  if (db?.engine) {
    try {
      const counts = options.jdbc
        ? await options.jdbc(options.dbConfig ?? sourceDbConfigFromEnv(), db.engine)
        : await jdbcCounts(db.engine, options.dbConfig);
      nodes = counts.nodes;
      audit = counts.audit;
      versions = counts.versions;
      dbSizeBytes = counts.dbSizeBytes;
      jdbcOk = true;
    } catch (error) {
      notes.push(`JDBC no disponible (${String(error)}); recuentos a 0`);
    }
  }

  let fileCount = 0;
  let contentSizeBytes = 0;
  let maxFileBytes = 0;
  const storePath = project.source.contentStore?.path;
  if (storePath) {
    const scan = await scanStore(storePath);
    fileCount = scan.files;
    contentSizeBytes = scan.bytes;
    maxFileBytes = scan.maxBytes;
    storeOk = true;
  }

  return {
    version,
    edition,
    nodes,
    audit,
    versions,
    dbSizeBytes,
    fileCount,
    contentSizeBytes,
    maxFileBytes,
    detected: { rest: restOk, jdbc: jdbcOk, store: storeOk },
    notes,
  };
}

async function jdbcCounts(
  engine: string,
  dbConfig?: SourceDbConfig,
): Promise<{ nodes: number; audit: number; versions: number; dbSizeBytes: number }> {
  const client = await connectSource(dbConfig ?? sourceDbConfigFromEnv());
  try {
    const nodes = Number((await queryRows(client, 'SELECT COUNT(*) AS n FROM alf_node'))[0]?.n ?? 0);
    const versions = await optional(client, 'SELECT COUNT(*) AS n FROM alf_node WHERE store_id IN (SELECT id FROM alf_store WHERE identifier = \'version2Store\')');
    const audit = await optional(client, 'SELECT COUNT(*) AS n FROM alf_audit_entry');
    const size = sizeSql(engine);
    const dbSizeBytes = size ? Number((await queryRows(client, size))[0]?.pg_database_size ?? 0) : 0;
    return { nodes, audit, versions, dbSizeBytes };
  } finally {
    await client.end();
  }
}

async function optional(client: Awaited<ReturnType<typeof connectSource>>, sql: string): Promise<number> {
  try {
    return Number((await queryRows(client, sql))[0]?.n ?? 0);
  } catch {
    return 0;
  }
}
