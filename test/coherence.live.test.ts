import { describe, expect, it } from 'vitest';
import { checkCoherence, explainMissing } from '../src/domain/coherence.js';

const storeRoot = process.env.MIGRATOR_LIVE_STORE ?? '/Users/horelvis/git/gadex-alfresco-docker-git/data/alf-repo-data/contentstore';
const hasDb = Boolean(process.env.MIGRATOR_SRC_DB_URL || process.env.MIGRATOR_SRC_DB_PASSWORD);

describe.runIf(hasDb)('coherence + explain (live)', () => {
  it('cuenta coherencia y explica los colgantes con su nodo', async () => {
    const report = await checkCoherence(storeRoot);
    console.log('coherence:', JSON.stringify(report));
    expect(report.refs).toBeGreaterThan(0);

    const dangling = await explainMissing(storeRoot);
    console.log('dangling:', JSON.stringify(dangling, null, 2));
    expect(dangling.length).toBe(report.dangling);
    for (const item of dangling) {
      expect(item.references.length).toBeGreaterThan(0);
    }
  }, 120_000);
});
