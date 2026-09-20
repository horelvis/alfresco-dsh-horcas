import { describe, expect, it } from 'vitest';
import { countCheck, storeCheck, verdictOf, verifyParity, type ParityProbes } from '../src/domain/verification.js';
import { parseProjectYaml } from '../src/domain/project-config.js';

const project = parseProjectYaml('project: demo\nsource:\n  version: "7.1.0"\ntarget:\n  version: "26.2"\n');

function probes(overrides: Partial<ParityProbes> = {}): ParityProbes {
  return {
    sourceCounts: async () => ({ nodes: 100, contentRefs: 80 }),
    targetCounts: async () => ({ nodes: 100, contentRefs: 80 }),
    sourceStore: async () => ({ files: 10, bytes: 1000 }),
    targetStore: async () => ({ files: 10, bytes: 1000 }),
    ...overrides,
  };
}

describe('verificacion de paridad origen->destino', () => {
  it('countCheck exacto: ok si igual, falla si difiere', () => {
    expect(countCheck('nodes', 100, 100).ok).toBe(true);
    expect(countCheck('nodes', 100, 101).ok).toBe(false);
  });

  it('countCheck respeta la tolerancia porcentual', () => {
    expect(countCheck('nodes', 100, 105, 10).ok).toBe(true);
    expect(countCheck('nodes', 100, 120, 10).ok).toBe(false);
  });

  it('countCheck con origen 0 exige destino 0', () => {
    expect(countCheck('x', 0, 0).ok).toBe(true);
    expect(countCheck('x', 0, 1).ok).toBe(false);
  });

  it('storeCheck compara ficheros y bytes', () => {
    expect(storeCheck('contentstore.bytes', 1000, 1000).ok).toBe(true);
    expect(storeCheck('contentstore.bytes', 1000, 900).ok).toBe(false);
  });

  it('verdictOf: PASS, FAIL y WARN segun corresponda', () => {
    expect(verdictOf([countCheck('a', 1, 1)], [], [])).toBe('PASS');
    expect(verdictOf([countCheck('a', 1, 2)], [], [])).toBe('FAIL');
    expect(verdictOf([countCheck('a', 1, 1)], [], ['sin store'])).toBe('WARN');
  });

  it('verifyParity: PASS con recuentos y store coincidentes', async () => {
    const report = await verifyParity(project, probes());
    expect(report.verdict).toBe('PASS');
    expect(report.counts).toHaveLength(2);
    expect(report.store).toHaveLength(2);
  });

  it('verifyParity: FAIL si el destino tiene menos nodos', async () => {
    const report = await verifyParity(project, probes({ targetCounts: async () => ({ nodes: 99, contentRefs: 80 }) }));
    expect(report.verdict).toBe('FAIL');
  });

  it('verifyParity: WARN si el content store no es verificable', async () => {
    const report = await verifyParity(project, probes({ targetStore: async () => undefined }));
    expect(report.verdict).toBe('WARN');
    expect(report.notes.length).toBeGreaterThan(0);
  });
});
