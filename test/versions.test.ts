import { describe, expect, it } from 'vitest';
import { breakingChangeGates, compareVersions, requiresSolrRemoval, resolveUpgradePath } from '../src/domain/versions.js';

describe('resolveUpgradePath', () => {
  it('7.1.0 -> 26.2 encadena 3 hops con el primero REQUIRES_VALIDATION', () => {
    const hops = resolveUpgradePath('7.1.0', '26.2');
    expect(hops.map((h) => `${h.from}->${h.to}`)).toEqual(['7.1.0->7.4', '7.4->25.3', '25.3->26.2']);
    expect(hops[0]?.pathClass).toBe('REQUIRES_VALIDATION');
    expect(hops[2]?.pathClass).toBe('SUPPORTED');
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
  it('26.2 EE incluye Solr-off y Java 21', () => {
    const gates = breakingChangeGates('26.2', 'EE');
    expect(gates.join(' ')).toContain('Java 21');
    expect(gates.join(' ')).toContain('Solr no soportado');
  });

  it('23.4 solo pide revisar breaking changes', () => {
    expect(breakingChangeGates('23.4', 'CE')).toEqual(['revisar breaking changes de 23.4']);
  });

  it('requiresSolrRemoval solo en EE >= 26', () => {
    expect(requiresSolrRemoval('26.2', 'EE')).toBe(true);
    expect(requiresSolrRemoval('26.2', 'CE')).toBe(false);
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
