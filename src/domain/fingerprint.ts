/** Fingerprint del ORIGEN: version, esquema (PK/UNIQUE), replicacion e inventario. Base del ensayo y del drift. */
import type { SourceFingerprint } from './experience.js';
import { loadSchemaReference } from './schema-reference.js';
import { compare, liveCatalog } from './schema-integrity.js';
import { connectSource, queryRows, REPLICATION_SQL, sourceDbConfigFromEnv } from '../infra/pg.js';

export async function gatherSourceFingerprint(version: string, dataDir: string): Promise<SourceFingerprint> {
  const reference = await loadSchemaReference(version, dataDir);
  const client = await connectSource(sourceDbConfigFromEnv());
  try {
    const integrity = compare(reference, await liveCatalog(client));
    const nodes = Number((await queryRows(client, 'SELECT COUNT(*) AS n FROM alf_node'))[0]?.n ?? 0);
    const dbSizeBytes = Number(
      (await queryRows(client, 'SELECT pg_database_size(current_database()) AS b'))[0]?.b ?? 0,
    );
    const replicationObjects = Number((await queryRows(client, REPLICATION_SQL))[0]?.objects ?? 0);
    return {
      version,
      referenceVersion: reference.version,
      schemaHealthy: integrity.healthy,
      schemaMismatches: integrity.mismatches.length,
      replicationObjects,
      nodes,
      dbSizeBytes,
    };
  } finally {
    await client.end();
  }
}
