import { describe, expect, it } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { latestByStep, saveCheckpoint } from '../src/domain/checkpoints.js';
import { runSteps } from '../src/domain/runner.js';
import { STEPS, stepById } from '../src/domain/steps.js';
import type { ProjectConfig } from '../src/domain/project-config.js';

const project: ProjectConfig = {
  project: 'demo',
  stage: 'test',
  access: { mode: 'local', hosts: {} },
  source: { version: '7.1.0', contentStore: { path: '/tmp/store' } },
  target: { version: '26.2', database: { host: 'dst', port: 5432, name: 'alfresco', user: 'alfresco' } },
  migration: {},
  raw: {},
};

describe('checkpoints', () => {
  it('guarda y devuelve el ultimo estado por paso', async () => {
    const state = await mkdtemp(path.join(os.tmpdir(), 'ckpt-'));
    await saveCheckpoint(state, { runId: 'r1', project: 'demo', step: 'a', status: 'OK', at: 't1', attempt: 1 });
    await saveCheckpoint(state, { runId: 'r1', project: 'demo', step: 'a', status: 'FAILED', at: 't2', attempt: 2 });
    const latest = await latestByStep(state, 'demo', 'r1');
    expect(latest.get('a')?.status).toBe('FAILED');
  });
});

describe('runner', () => {
  it('dry-run no escribe y registra SKIPPED', async () => {
    const state = await mkdtemp(path.join(os.tmpdir(), 'run-'));
    const report = await runSteps({ project, destination: { name: 'local' }, state, runId: 'r1', dryRun: true }, ['restore-target-db'], { dryRun: true });
    expect(report.ok).toBe(true);
    expect(report.results[0]?.skipped).toBe(true);
  });

  it('reanuda omitiendo pasos ya OK', async () => {
    const state = await mkdtemp(path.join(os.tmpdir(), 'run-'));
    await saveCheckpoint(state, { runId: 'r1', project: 'demo', step: 'copy-content', status: 'OK', at: 't', attempt: 1 });
    const report = await runSteps({ project, destination: { name: 'local' }, state, runId: 'r1', dryRun: true }, ['copy-content'], { resume: true, dryRun: true });
    expect(report.results[0]?.detail).toContain('reanudado');
  });

  it('falla con paso desconocido', async () => {
    const state = await mkdtemp(path.join(os.tmpdir(), 'run-'));
    const report = await runSteps({ project, destination: { name: 'local' }, state, runId: 'r1', dryRun: true }, ['no-existe']);
    expect(report.ok).toBe(false);
  });
});

describe('steps', () => {
  it('el catalogo marca correctamente los pasos de escritura', () => {
    expect(stepById('restore-target-db')?.writes).toBe(true);
    expect(stepById('preflight-target')?.writes).toBe(false);
    expect(STEPS.length).toBeGreaterThanOrEqual(6);
  });
});
