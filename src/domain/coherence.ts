/**
 * Coherencia DB <-> content store y forense de referencias colgantes (read-only sobre el origen).
 * Portado del core Spring: cuenta refs/orphans/dangling y, para cada colgado, resuelve nodo/tipo/ruta.
 */
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { queryRows, connectSource, sourceDbConfigFromEnv, selectOnly } from '../infra/pg.js';

export interface CoherenceReport {
  refs: number;
  storeObjects: number;
  dangling: number;
  orphans: number;
  verdict: 'PASS' | 'FAIL';
  samples: string[];
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

async function listStoreObjects(root: string): Promise<string[]> {
  const objects: string[] = [];
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
        objects.push(relative);
      }
    }
  }
  await walk(root, '');
  return objects;
}

const storeRelative = (contentUrl: string): string => contentUrl.replace(/^store:\/\//, '');

export async function checkCoherence(storeRoot: string): Promise<CoherenceReport> {
  const client = await connectSource(sourceDbConfigFromEnv());
  try {
    const refs = await queryRows(client, REFS_SQL);
    const refUrls = new Set(refs.map((r) => String(r.content_url)));
    const objects = await listStoreObjects(storeRoot);
    const objectSet = new Set(objects);
    const dangling = [...refUrls].filter((url) => !objectSet.has(storeRelative(url)));
    const orphans = objects.filter((obj) => !refUrls.has(`store://${obj}`));
    return {
      refs: refUrls.size,
      storeObjects: objects.length,
      dangling: dangling.length,
      orphans: orphans.length,
      verdict: dangling.length > 0 ? 'FAIL' : 'PASS',
      samples: dangling.slice(0, 5),
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
    const objects = new Set(await listStoreObjects(storeRoot));
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
