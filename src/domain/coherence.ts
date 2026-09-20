/**
 * Coherencia DB <-> content store y forense de referencias colgantes (read-only sobre el origen).
 * Portado del core Spring: cuenta refs/orphans/dangling y, para cada colgado, resuelve nodo/tipo/ruta.
 */
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { queryRows, connectSource, sourceDbConfigFromEnv, selectOnly } from '../infra/pg.js';

export interface CoherenceReport {
  refs: number;
  storeObjects: number;
  dangling: number;
  orphans: number;
  sizeMismatch: number;
  verdict: 'PASS' | 'WARN' | 'FAIL';
  samples: string[];
}

export type CoherencePolicy = 'FAIL_ON_DANGLING' | 'WARN' | 'REPAIR';

/**
 * `true` si la policy del proyecto exige abortar por referencias colgantes. Por defecto se es
 * conservador (`FAIL_ON_DANGLING`); `WARN`/`REPAIR` permiten continuar documentando el colgado.
 */
export function coherenceBlocked(policy: string | undefined, dangling: number): boolean {
  return (policy ?? 'FAIL_ON_DANGLING').trim().toUpperCase() === 'FAIL_ON_DANGLING' && dangling > 0;
}

export interface DanglingReference {
  contentUrl: string;
  sizeBytes: number;
  markedOrphan: boolean;
  roles: string[];
  references: Array<{ nodeId: number; nodeRef: string; role: string; type: string; name: string; path: string }>;
  liveReferenced: boolean;
}

const REFS_SQL = 'SELECT id, content_url, content_size, orphan_time FROM alf_content_url';

/** Objetos del content store: ruta relativa -> tamano en bytes. */
async function listStoreObjects(root: string): Promise<Map<string, number>> {
  const objects = new Map<string, number>();
  async function walk(dir: string, prefix: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === '.DS_Store') continue;
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(path.join(dir, entry.name), relative);
      } else if (entry.name.endsWith('.bin')) {
        try {
          const { size } = await stat(path.join(dir, entry.name));
          objects.set(relative, size);
        } catch {
          objects.set(relative, -1); // ilegible: tamano desconocido
        }
      }
    }
  }
  await walk(root, '');
  return objects;
}

const storeRelative = (contentUrl: string): string => contentUrl.replace(/^store:\/\//, '');

export interface CoherenceDiff {
  refs: number;
  storeObjects: number;
  dangling: string[];
  orphans: string[];
  sizeMismatch: Array<{ path: string; db: number; store: number }>;
  verdict: 'PASS' | 'WARN' | 'FAIL';
}

/** Comparacion pura (hechos) de referencias DB contra objetos del store. */
export function diffCoherence(refSize: Map<string, number>, objects: Map<string, number>): CoherenceDiff {
  const dangling = [...refSize.keys()].filter((rel) => !objects.has(rel));
  const orphans = [...objects.keys()].filter((rel) => !refSize.has(rel));
  const sizeMismatch = [...refSize.entries()]
    .filter(([rel, size]) => {
      const storeSize = objects.get(rel);
      return storeSize !== undefined && storeSize >= 0 && size > 0 && storeSize !== size;
    })
    .map(([rel, size]) => ({ path: rel, db: size, store: objects.get(rel) as number }));
  const verdict = dangling.length > 0 ? 'FAIL' : orphans.length > 0 || sizeMismatch.length > 0 ? 'WARN' : 'PASS';
  return { refs: refSize.size, storeObjects: objects.size, dangling, orphans, sizeMismatch, verdict };
}

export async function checkCoherence(storeRoot: string): Promise<CoherenceReport> {
  const client = await connectSource(sourceDbConfigFromEnv());
  try {
    const refs = await queryRows(client, REFS_SQL);
    const refSize = new Map<string, number>();
    for (const row of refs) {
      refSize.set(storeRelative(String(row.content_url)), Number(row.content_size ?? 0));
    }
    const objects = await listStoreObjects(storeRoot);
    const diff = diffCoherence(refSize, objects);
    return {
      refs: diff.refs,
      storeObjects: diff.storeObjects,
      dangling: diff.dangling.length,
      orphans: diff.orphans.length,
      sizeMismatch: diff.sizeMismatch.length,
      verdict: diff.verdict,
      samples: diff.dangling.slice(0, 5),
    };
  } finally {
    await client.end();
  }
}

function role(protocol: string, identifier: string): string {
  const id = (identifier ?? '').toLowerCase();
  if (id.includes('version2')) return 'version';
  if ((protocol ?? '').toLowerCase() === 'archive') return 'papelera';
  if (id.includes('spacesstore')) return 'vivo';
  return 'otro';
}

/** Explica cada content_url colgado: quien lo referencia y la ruta del documento. */
export async function explainMissing(storeRoot: string): Promise<DanglingReference[]> {
  const client = await connectSource(sourceDbConfigFromEnv());
  try {
    const refs = await queryRows(client, REFS_SQL);
    const objects = new Set((await listStoreObjects(storeRoot)).keys());
    const result: DanglingReference[] = [];
    for (const row of refs) {
      const url = String(row.content_url);
      if (objects.has(storeRelative(url))) continue;
      const urlId = Number(row.id ?? 0);
      const dataIds = urlId
        ? await queryRows(client, 'SELECT id FROM alf_content_data WHERE content_url_id = ?', [urlId])
        : [];
      const references: DanglingReference['references'] = [];
      const roles = new Set<string>();
      for (const data of dataIds) {
        const nodes = await queryRows(
          client,
          `SELECT DISTINCT np.node_id, n.uuid, s.protocol, s.identifier
             FROM alf_node_properties np JOIN alf_node n ON n.id = np.node_id
             JOIN alf_store s ON s.id = n.store_id WHERE np.long_value = ?`,
          [Number(data.id)],
        );
        for (const node of nodes) {
          const nodeId = Number(node.node_id);
          const protocol = String(node.protocol ?? '');
          const identifier = String(node.identifier ?? '');
          const r = role(protocol, identifier);
          roles.add(r);
          references.push({
            nodeId,
            nodeRef: `${protocol}://${identifier}/${node.uuid}`,
            role: r,
            type: await nodeType(client, nodeId),
            name: (await nodeName(client, nodeId)) ?? '',
            path: await nodePath(client, nodeId),
          });
        }
      }
      result.push({
        contentUrl: url,
        sizeBytes: Number(row.content_size ?? 0),
        markedOrphan: row.orphan_time !== null && row.orphan_time !== undefined,
        roles: [...roles],
        references,
        liveReferenced: roles.has('vivo'),
      });
    }
    return result;
  } finally {
    await client.end();
  }
}

async function nodeType(client: Awaited<ReturnType<typeof connectSource>>, nodeId: number): Promise<string> {
  const rows = await queryRows(client, 'SELECT q.local_name FROM alf_node n JOIN alf_qname q ON q.id = n.type_qname_id WHERE n.id = ?', [nodeId]);
  return String(rows[0]?.local_name ?? '?');
}

async function nodeName(client: Awaited<ReturnType<typeof connectSource>>, nodeId: number): Promise<string | undefined> {
  const rows = await queryRows(
    client,
    `SELECT np.string_value FROM alf_node_properties np JOIN alf_qname q ON q.id = np.qname_id
     WHERE np.node_id = ? AND q.local_name = 'name' AND np.string_value IS NOT NULL LIMIT 1`,
    [nodeId],
  );
  return rows[0]?.string_value ? String(rows[0].string_value) : undefined;
}

async function nodePath(client: Awaited<ReturnType<typeof connectSource>>, nodeId: number): Promise<string> {
  const rows = await queryRows(
    client,
    selectOnly(`WITH RECURSIVE up AS (
        SELECT n.id, 0 AS lvl FROM alf_node n WHERE n.id = ?
        UNION ALL
        SELECT p.id, up.lvl + 1 FROM up
        JOIN alf_child_assoc ca ON ca.child_node_id = up.id AND ca.is_primary = true
        JOIN alf_node p ON p.id = ca.parent_node_id WHERE up.lvl < 30)
      SELECT (SELECT np.string_value FROM alf_node_properties np JOIN alf_qname q ON q.id = np.qname_id
              WHERE np.node_id = u.id AND q.local_name = 'name' AND np.string_value IS NOT NULL LIMIT 1) AS name
      FROM up u ORDER BY u.lvl DESC`),
    [nodeId],
  );
  const parts = rows.map((r) => (r.name ? String(r.name) : '')).filter(Boolean);
  return parts.length ? `/${parts.join('/')}` : '/';
}
