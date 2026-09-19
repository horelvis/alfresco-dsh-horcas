import { describe, expect, it } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  attemptSummary,
  campaignId,
  compareFingerprints,
  hasBlockingDrift,
  latestRehearsal,
  loadExperiences,
  recordAttempt,
  resumePoint,
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

describe('campana de experiencia (multiples intentos)', () => {
  it('acumula intentos en la misma campana y permite reanudar desde el fallo', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'exp-'));

    // Intento 1: falla en restore.
    await recordAttempt(dir, {
      project: 'p',
      stage: 'test',
      sourceVersion: '7.1.0',
      targetVersion: '26.2',
      fingerprint: fp(),
      attempt: { id: 'run1', at: '2026-09-19T10:00:00Z', outcome: 'failed', failedStep: 'restore-target-db', resumeFrom: 'restore-target-db', steps: [{ id: 'copy-content', ok: true, durationMs: 10 }], findings: [] },
    });
    // Intento 2: reanuda y completa.
    const record = await recordAttempt(dir, {
      project: 'p',
      stage: 'test',
      sourceVersion: '7.1.0',
      targetVersion: '26.2',
      fingerprint: fp(),
      attempt: { id: 'run2', at: '2026-09-19T11:00:00Z', outcome: 'ok', steps: [{ id: 'restore-target-db', ok: true, durationMs: 20 }], findings: [] },
    });

    expect(record.id).toBe(campaignId('p', 'test'));
    expect(record.attempts).toHaveLength(2);
    expect(record.validated).toBe(true);
    expect(attemptSummary(record)).toContain('fallo en restore-target-db');
    expect(await loadExperiences(dir, 'p')).toHaveLength(1); // una campana, no dos
  });

  it('resumePoint apunta al ultimo intento fallido', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'exp-'));
    await recordAttempt(dir, {
      project: 'p',
      stage: 'test',
      sourceVersion: '7.1.0',
      targetVersion: '26.2',
      fingerprint: fp(),
      attempt: { id: 'r1', at: '2026-09-19T10:00:00Z', outcome: 'failed', failedStep: 'reindex', resumeFrom: 'reindex', steps: [], findings: [] },
    });
    const record = (await loadExperiences(dir, 'p'))[0];
    expect(resumePoint(record)).toBe('reindex');
  });

  it('el ultimo ensayo validado se devuelve aunque haya intentos fallidos previos', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'exp-'));
    await recordAttempt(dir, { project: 'p', stage: 'test', sourceVersion: '7.1.0', targetVersion: '26.2', fingerprint: fp(), attempt: { id: 'r1', at: '2026-09-19T10:00:00Z', outcome: 'failed', failedStep: 'x', steps: [], findings: [] } });
    await recordAttempt(dir, { project: 'p', stage: 'clone', sourceVersion: '7.1.0', targetVersion: '26.2', fingerprint: fp(), attempt: { id: 'r2', at: '2026-09-19T11:00:00Z', outcome: 'ok', steps: [], findings: [] } });
    await recordAttempt(dir, { project: 'p', stage: 'prod', sourceVersion: '7.1.0', targetVersion: '26.2', fingerprint: fp(), attempt: { id: 'r3', at: '2026-09-19T12:00:00Z', outcome: 'ok', steps: [], findings: [] } });

    const rehearsal = await latestRehearsal(dir, 'p');
    expect(rehearsal?.stage).toBe('clone');
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
    expect(compareFingerprints(fp(), fp({ replicationObjects: 3 }))[0]).toMatchObject({ kind: 'REPLICATION', severity: 'BLOCKER' });
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
