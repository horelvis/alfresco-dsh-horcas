import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { latestRunId, saveCheckpoint } from '../src/domain/checkpoints.js';

const cp = (runId: string, project: string, at: string) => ({
  runId,
  project,
  step: 'a',
  status: 'OK' as const,
  at,
  attempt: 1,
});

describe('checkpoints', () => {
  it('latestRunId devuelve el run mas reciente (por proyecto si se indica)', async () => {
    const state = await mkdtemp(path.join(os.tmpdir(), 'cp-'));
    await saveCheckpoint(state, cp('r1', 'p', '2026-01-01T00:00:00.000Z'));
    await saveCheckpoint(state, cp('r2', 'p', '2026-01-02T00:00:00.000Z'));
    await saveCheckpoint(state, cp('other', 'q', '2026-01-03T00:00:00.000Z'));

    expect(await latestRunId(state, 'p')).toBe('r2');
    expect(await latestRunId(state)).toBe('other');
    await rm(state, { recursive: true, force: true });
  });

  it('latestRunId sin checkpoints devuelve undefined', async () => {
    const state = await mkdtemp(path.join(os.tmpdir(), 'cp-'));
    expect(await latestRunId(state, 'p')).toBeUndefined();
    await rm(state, { recursive: true, force: true });
  });
});
