import { describe, expect, it } from 'vitest';
import { breakingChangeGates, requiresSolrRemoval, resolveUpgradePath, upgradeMatrix } from '../src/domain/upgrade-paths.js';

describe('matriz de upgrade (data-driven)', () => {
  it('la matriz se carga desde data/upgrade-paths.yaml', () => {
    const matrix = upgradeMatrix();
    expect(matrix.rules.length).toBeGreaterThan(0);
    expect(Object.keys(matrix.notes)).toContain('java21');
    expect(matrix.gates.length).toBeGreaterThan(0);
    expect(matrix.solrRemoval).toBeDefined();
  });

  it('las notas de la ruta provienen de la matriz (dato, no codigo)', () => {
    const notes = upgradeMatrix().notes;
    const hops = resolveUpgradePath('7.1.0', '26.2');
    const flat = hops.flatMap((h) => h.notes);
    expect(flat).toContain(notes.java21);
    expect(flat).toContain(notes.solrOff);
  });

  it('gates y solrRemoval se evaluan desde la matriz', () => {
    expect(breakingChangeGates('26.2', 'EE')).toContain(upgradeMatrix().gates.find((g) => g.text.includes('Solr'))?.text);
    expect(requiresSolrRemoval('26.2', 'EE')).toBe(true);
    expect(breakingChangeGates('23.4', 'CE')).toEqual([upgradeMatrix().gatesFallback?.replace('$TO', '23.4')]);
  });
});
