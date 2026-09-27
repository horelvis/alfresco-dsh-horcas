import { describe, expect, it } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runAudit } from '../src/domain/audit.js';
import type { ProjectConfig } from '../src/domain/project-config.js';

const project = (target: Record<string, unknown> = {}): ProjectConfig =>
  ({
    project: 'g',
    stage: 'test',
    source: { version: '7.1.0', edition: 'CE', database: { engine: 'postgresql', name: 'alfresco' }, contentStore: { path: '/src' }, search: { engine: 'solr' } },
    target: { version: '26.2', edition: 'CE', deployment: 'compose', baseUrl: 'http://h:8080/alfresco', search: { engine: 'elasticsearch' }, ...target },
    migration: { contentStrategy: 'C2', dbStrategy: 'D2', indexStrategy: 'I2', coherencePolicy: 'WARN' },
  }) as unknown as ProjectConfig;

const jsonl = (dir: string, name: string, rows: unknown[]): Promise<void> =>
  writeFile(path.join(dir, name), rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');

const dupExperience = {
  id: 'g::test', project: 'g', stage: 'test', sourceVersion: '7.1.0', targetVersion: '26.2',
  createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
  fingerprint: { version: '7.1.0', referenceVersion: '7.1.0', schemaHealthy: true, schemaMismatches: 0, replicationObjects: 0, nodes: 1, dbSizeBytes: 1 },
  validated: true,
  attempts: [
    { id: 'r1', at: '2026-01-01T00:00:00Z', outcome: 'ok', steps: [], findings: [] },
    { id: 'r1', at: '2026-01-01T00:05:00Z', outcome: 'ok', steps: [], findings: [] },
  ],
};

describe('auditoria determinista (Nivel 0)', () => {
  it('detecta intentos duplicados por runId (FAIL)', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'audit-'));
    await jsonl(dir, 'experience.jsonl', [dupExperience]);
    const res = await runAudit(project(), dir, '2026-01-01T01:00:00Z');
    expect(res.findings.some((f) => f.code === 'INTENTOS_DUPLICADOS' && f.severity === 'FAIL')).toBe(true);
  });

  it('detecta un hop fuera de la ruta soportada (FAIL)', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'audit-'));
    await jsonl(dir, 'hops.jsonl', [{ project: 'g', from: '7.1.0', to: '99.9', at: '2026-01-01T00:00:00Z' }]);
    const res = await runAudit(project(), dir, '2026-01-01T01:00:00Z');
    expect(res.findings.some((f) => f.code === 'HOP_FUERA_DE_RUTA' && f.severity === 'FAIL')).toBe(true);
  });

  it('final alcanzado sin verify-target es FAIL', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'audit-'));
    await jsonl(dir, 'hops.jsonl', [
      { project: 'g', from: '7.1.0', to: '7.4', at: '2026-01-01T00:00:00Z' },
      { project: 'g', from: '7.4', to: '25.3', at: '2026-01-01T00:01:00Z' },
      { project: 'g', from: '25.3', to: '26.2', at: '2026-01-01T00:02:00Z' },
    ]);
    await jsonl(dir, 'checkpoints.jsonl', [
      { runId: 'r1', project: 'g', step: 'smoke-boot', status: 'OK', at: '2026-01-01T00:02:00Z', attempt: 1, detail: 'hop 26.2', durationMs: 1 },
    ]);
    const res = await runAudit(project(), dir, '2026-01-01T01:00:00Z');
    expect(res.findings.some((f) => f.code === 'SIN_VERIFY' && f.severity === 'FAIL')).toBe(true);
  });

  it('anota la URL real de Share sin proxy (INFO)', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'audit-'));
    const res = await runAudit(project({ stack: { share: true } }), dir, '2026-01-01T01:00:00Z');
    expect(res.findings.some((f) => f.code === 'SHARE_URL' && f.detail.includes(':8081'))).toBe(true);
  });
});
