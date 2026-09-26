import { describe, expect, it } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { applyEvidence, buildChecklist, type ChecklistInput } from '../src/domain/checklist.js';
import { checklistFacts, recordEvidence } from '../src/domain/evidence.js';

const input: ChecklistInput = {
  project: 'g', sourceVersion: '7.1.0', targetVersion: '26.2', sourceEdition: 'CE', targetEdition: 'CE',
  sourceSearch: 'solr', targetSearch: 'elasticsearch',
  hops: [{ from: '7.1.0', to: '7.4', pathClass: 'SUPPORTED' }, { from: '7.4', to: '25.3', pathClass: 'SUPPORTED' }, { from: '25.3', to: '26.2', pathClass: 'SUPPORTED' }],
};
const hops = input.hops.map((h) => ({ to: h.to }));
const status = (items: ReturnType<typeof buildChecklist>, key: string) => items.find((i) => i.key === key)?.status;

describe('checklist resuelto con evidencia', () => {
  it('sin evidencia todo lo ejecutable sigue PENDING (nunca OK sin prueba)', async () => {
    const state = await mkdtemp(path.join(os.tmpdir(), 'ev-'));
    const items = applyEvidence(buildChecklist(input), await checklistFacts(state, 'g', hops));
    expect(status(items, 'schema-pk')).toBe('PENDING');
    expect(status(items, 'reindex')).toBe('PENDING');
    expect(status(items, 'gates')).toBe('PENDING');
    expect(items.find((i) => i.key === 'solr-first')).toBeUndefined(); // destino sin Solr: no aplica
  });

  it('checkpoints, hops y chequeos marcan OK/WARN; lo post solo cuenta tras el hop final', async () => {
    const state = await mkdtemp(path.join(os.tmpdir(), 'ev-'));
    const cp = (step: string, st: string, detail = '') => JSON.stringify({ runId: 'r', project: 'g', step, status: st, at: '2026-09-26T09:30:00Z', attempt: 1, detail });
    await writeFile(path.join(state, 'checkpoints.jsonl'), [cp('backup-source-db', 'OK'), cp('provision-hop', 'OK'), cp('reindex', 'SKIPPED', 'dry-run')].join('\n') + '\n');
    await recordEvidence(state, 'g', 'schema-pk', 'OK', '45 tablas');
    await recordEvidence(state, 'g', 'coherence', 'WARN', 'dangling=1 policy=WARN');
    await recordEvidence(state, 'g', 'verify', 'OK', 'PASS'); // ANTES del hop final: no cuenta como post
    await writeFile(path.join(state, 'hops.jsonl'), hops.map((h) => JSON.stringify({ project: 'g', from: 'x', to: h.to, at: '2099-01-01T00:00:00Z' })).join('\n') + '\n');
    const items = applyEvidence(buildChecklist(input), await checklistFacts(state, 'g', hops));
    expect(status(items, 'backup-db')).toBe('OK');
    expect(status(items, 'provisioned')).toBe('OK');
    expect(status(items, 'schema-pk')).toBe('OK');
    expect(status(items, 'coherence')).toBe('WARN');
    expect(status(items, 'gates')).toBe('OK');
    expect(status(items, 'reindex')).toBe('PENDING');
    expect(status(items, 'verify')).toBe('PENDING');
    expect(status(items, 'modules')).toBe('PENDING');
  });
});

describe('inventario remoto del content store', () => {
  it('mide el tamaño aparente (no bloques de du)', async () => {
    const { remoteStoreInventory } = await import('../src/domain/verification.js');
    const dir = await mkdtemp(path.join(os.tmpdir(), 'store-'));
    await writeFile(path.join(dir, 'a.bin'), Buffer.alloc(10));
    await writeFile(path.join(dir, 'b.bin'), Buffer.alloc(5));
    const inv = await remoteStoreInventory({ name: 'local' }, dir);
    expect(inv?.files).toBe(2);
    // GNU find: 15 bytes exactos; BSD (macOS) cae a du (bloques).
    expect(inv!.bytes).toBeGreaterThanOrEqual(15);
  });
});
