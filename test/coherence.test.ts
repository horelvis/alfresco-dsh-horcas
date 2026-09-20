import { describe, expect, it } from 'vitest';
import { coherenceBlocked, diffCoherence } from '../src/domain/coherence.js';

const m = (entries: Array<[string, number]>): Map<string, number> => new Map(entries);

describe('diffCoherence (dangling/orphans/sizeMismatch)', () => {
  it('coherente -> PASS', () => {
    const db = m([['a.bin', 100], ['b.bin', 200]]);
    const store = m([['a.bin', 100], ['b.bin', 200]]);
    const diff = diffCoherence(db, store);
    expect(diff.verdict).toBe('PASS');
    expect(diff.dangling).toHaveLength(0);
    expect(diff.orphans).toHaveLength(0);
    expect(diff.sizeMismatch).toHaveLength(0);
  });

  it('dangling -> FAIL', () => {
    const db = m([['a.bin', 100], ['missing.bin', 50]]);
    const store = m([['a.bin', 100]]);
    const diff = diffCoherence(db, store);
    expect(diff.verdict).toBe('FAIL');
    expect(diff.dangling).toEqual(['missing.bin']);
  });

  it('orphans -> WARN', () => {
    const diff = diffCoherence(m([['a.bin', 100]]), m([['a.bin', 100], ['extra.bin', 10]]));
    expect(diff.verdict).toBe('WARN');
    expect(diff.orphans).toEqual(['extra.bin']);
  });

  it('sizeMismatch -> WARN con detalle db vs store', () => {
    const diff = diffCoherence(m([['a.bin', 100]]), m([['a.bin', 80]]));
    expect(diff.verdict).toBe('WARN');
    expect(diff.sizeMismatch).toEqual([{ path: 'a.bin', db: 100, store: 80 }]);
  });

  it('tamano desconocido (-1) no cuenta como mismatch', () => {
    const diff = diffCoherence(m([['a.bin', 100]]), m([['a.bin', -1]]));
    expect(diff.sizeMismatch).toHaveLength(0);
    expect(diff.verdict).toBe('PASS');
  });
});

describe('coherenceBlocked (aplicacion de la policy)', () => {
  it('FAIL_ON_DANGLING (y por defecto) bloquea solo con dangling', () => {
    expect(coherenceBlocked('FAIL_ON_DANGLING', 1)).toBe(true);
    expect(coherenceBlocked(undefined, 1)).toBe(true);
    expect(coherenceBlocked('FAIL_ON_DANGLING', 0)).toBe(false);
  });

  it('WARN / REPAIR nunca bloquean', () => {
    expect(coherenceBlocked('WARN', 3)).toBe(false);
    expect(coherenceBlocked('REPAIR', 3)).toBe(false);
  });
});
