import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { loadSchemaReference } from '../src/domain/schema-reference.js';
import { compare, describe as describeIntegrity, liveCatalog } from '../src/domain/schema-integrity.js';
import { connectSource, sourceDbConfigFromEnv } from '../src/infra/pg.js';

const hasDb = Boolean(process.env.MIGRATOR_SRC_DB_URL || process.env.MIGRATOR_SRC_DB_PASSWORD);

describe.runIf(hasDb)('schema check (live)', () => {
  it('el esquema del origen casa con la referencia de su version', async () => {
    const reference = await loadSchemaReference('7.1.0', path.resolve(process.cwd(), 'data'));
    const client = await connectSource(sourceDbConfigFromEnv());
    try {
      const integrity = compare(reference, await liveCatalog(client));
      console.log(describeIntegrity(integrity));
      expect(integrity.healthy).toBe(true);
    } finally {
      await client.end();
    }
  }, 30_000);
});
