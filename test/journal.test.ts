import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { appendJournal, latestJournal, loadJournal } from '../src/domain/journal.js';

describe('journal', () => {
  it('anota y lee hitos por proyecto; latestJournal devuelve el mas reciente', async () => {
    const state = await mkdtemp(path.join(os.tmpdir(), 'jr-'));
    await appendJournal(state, { project: 'p', kind: 'assessment', summary: 'a1', at: '2026-01-01T00:00:00.000Z' });
    await appendJournal(state, { project: 'p', kind: 'plan', summary: 'p1', at: '2026-01-02T00:00:00.000Z' });
    await appendJournal(state, { project: 'q', kind: 'note', summary: 'otro', at: '2026-01-03T00:00:00.000Z' });

    expect(await loadJournal(state, 'p')).toHaveLength(2);
    expect((await latestJournal(state, 'p'))?.summary).toBe('p1');
    expect((await latestJournal(state, 'p', 'assessment'))?.summary).toBe('a1');
    await rm(state, { recursive: true, force: true });
  });

  it('sin journal devuelve vacio', async () => {
    const state = await mkdtemp(path.join(os.tmpdir(), 'jr-'));
    expect(await loadJournal(state, 'p')).toEqual([]);
    await rm(state, { recursive: true, force: true });
  });
});
