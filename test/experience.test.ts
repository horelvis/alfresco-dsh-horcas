import { describe, expect, it } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  compareFingerprints,
  hasBlockingDrift,
  latestRehearsal,
  loadExperiences,
  recordExperience,
  type ExperienceRecord,
  type SourceFingerprint,
} from '../src/domain/experience.js';

function fp(over: Partial<SourceFingerprint> = {}): SourceFingerprint {
  return {
    version: '7.1.0',
    referenceVersion: '7.1.0',
    schemaHealthy: true,
    schemaMismatches: 0,
    replicationObjects: 0,
    nodes: 1000,
    dbSizeBytes: 1_000_000,
    ...over,
  };
}

function rec(over: Partial<ExperienceRecord> = {}): ExperienceRecord {
  return {
    id: 'p-test-1',
    createdAt: '2026-09-19T10:00:00Z',
    project: 'p',
    stage: 'test',
    sourceVersion: '7.1.0',
    targetVersion: '26.2',
    validated: true,
    fingerprint: fp(),
    steps: [],
    findings: [],
    ...over,
  };
}

describe('experience store', () => {
  it('registra, carga y devuelve el ultimo ensayo validado', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'exp-'));
    await recordExperience(dir, rec({ id: 'a', createdAt: '2026-09-19T09:00:00Z' }));
    await recordExperience(dir, rec({ id: 'b', createdAt: '2026-09-19T11:00:00Z', stage: 'clone' }));
    await recordExperience(dir, rec({ id: 'prod', createdAt: '2026-09-19T12:00:00Z', stage: 'prod' }));

    expect(await loadExperiences(dir, 'p')).toHaveLength(3);
    const latest = await latestRehearsal(dir, 'p');
    expect(latest?.id).toBe('b'); // el prod no cuenta como ensayo
  });
});

describe('compareFingerprints (drift ensayo -> prod)', () => {
  it('sin cambios no hay drift', () => {
    expect(compareFingerprints(fp(), fp())).toEqual([]);
  });

  it('esquema con defecto es BLOCKER', () => {
    const drift = compareFingerprints(fp(), fp({ schemaHealthy: false, schemaMismatches: 2 }));
    expect(drift.some((d) => d.kind === 'SCHEMA_DEFECT' && d.severity === 'BLOCKER')).toBe(true);
    expect(hasBlockingDrift(drift)).toBe(true);
  });

  it('CDC activo es BLOCKER', () => {
    expect(compareFingerprints(fp(), fp({ replicationObjects: 3 }))[0]).toMatchObject({
      kind: 'REPLICATION',
      severity: 'BLOCKER',
    });
  });

  it('version distinta es BLOCKER', () => {
    expect(compareFingerprints(fp(), fp({ version: '23.4.0' }))[0]).toMatchObject({ kind: 'VERSION', severity: 'BLOCKER' });
  });

  it('desvio de inventario es WARN', () => {
    const drift = compareFingerprints(fp(), fp({ nodes: 2000 }));
    expect(drift[0]).toMatchObject({ kind: 'NODE_COUNT', severity: 'WARN' });
    expect(hasBlockingDrift(drift)).toBe(false);
  });
});
