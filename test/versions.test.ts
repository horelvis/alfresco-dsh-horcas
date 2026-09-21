import { describe, expect, it } from 'vitest';
import { compareVersions } from '../src/domain/versions.js';
import { breakingChangeGates, requiresSolrRemoval, resolveUpgradePath } from '../src/domain/upgrade-paths.js';

describe('resolveUpgradePath', () => {
  it('7.1.0 -> 26.2 encadena 3 hops SOPORTADOS (no se puede saltar 7.4)', () => {
    const hops = resolveUpgradePath('7.1.0', '26.2');
    expect(hops.map((h) => `${h.from}->${h.to}`)).toEqual(['7.1.0->7.4', '7.4->25.3', '25.3->26.2']);
    expect(hops.every((h) => h.pathClass === 'SUPPORTED')).toBe(true);
  });

  it('25.3.0 -> 26.2 es un unico hop soportado', () => {
    const hops = resolveUpgradePath('25.3.0', '26.2');
    expect(hops).toHaveLength(1);
    expect(hops[0]?.pathClass).toBe('SUPPORTED');
  });

  it('el primer hop 7.4+ ya no valida', () => {
    expect(resolveUpgradePath('7.4.2', '26.2')[0]?.pathClass).toBe('SUPPORTED');
  });
});

describe('breakingChangeGates', () => {
  it('26.2 incluye Solr-off (CE y EE) y Java 21', () => {
    const gates = breakingChangeGates('26.2', 'EE');
    expect(gates.join(' ')).toContain('Java 21');
    expect(gates.join(' ')).toContain('Solr eliminado en 26.x');
    expect(breakingChangeGates('26.2', 'CE').join(' ')).toContain('Solr eliminado en 26.x');
  });

  it('23.4 solo pide revisar breaking changes', () => {
    expect(breakingChangeGates('23.4', 'CE')).toEqual(['revisar breaking changes de 23.4']);
  });

  it('requiresSolrRemoval en 26.x (CE y EE); no antes', () => {
    expect(requiresSolrRemoval('26.2', 'EE')).toBe(true);
    expect(requiresSolrRemoval('26.2', 'CE')).toBe(true);
    expect(requiresSolrRemoval('25.3', 'EE')).toBe(false);
    expect(requiresSolrRemoval('23.4', 'EE')).toBe(false);
  });
});

describe('compareVersions', () => {
  it('ordena por mayor/menor', () => {
    expect(compareVersions('7.1.0', '7.4')).toBeLessThan(0);
    expect(compareVersions('25.3', '26.2')).toBeLessThan(0);
    expect(compareVersions('26.2.0', '26.2')).toBe(0);
  });
});
