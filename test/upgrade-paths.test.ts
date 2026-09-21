import { describe, expect, it } from 'vitest';
import {
  breakingChangeGates,
  requireSupportedUpgradePath,
  requiresSolrRemoval,
  resolveUpgradePath,
  upgradeMatrix,
  upgradePathWarnings,
} from '../src/domain/upgrade-paths.js';

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

  it('7.1 -> 26.2 exige la cadena de 3 hops en orden', () => {
    const hops = requireSupportedUpgradePath('7.1.0', '26.2');
    expect(hops.map((h) => `${h.from}->${h.to}`)).toEqual(['7.1.0->7.4', '7.4->25.3', '25.3->26.2']);
  });

  it('destino 7.4 -> un UNICO hop (no incluye hops posteriores al destino)', () => {
    const hops = resolveUpgradePath('7.1.0', '7.4');
    expect(hops.map((h) => `${h.from}->${h.to}`)).toEqual(['7.1.0->7.4']);
    expect(hops[0]?.intermediate).toBe(false);
  });

  it('destino 25.3 -> corta en 25.3 (no incluye 25.3->26.2)', () => {
    const hops = resolveUpgradePath('7.1.0', '25.3');
    expect(hops.map((h) => `${h.from}->${h.to}`)).toEqual(['7.1.0->7.4', '7.4->25.3']);
  });

  it('un salto de version no soportado se rechaza', () => {
    expect(() => requireSupportedUpgradePath('4.0', '26.2')).toThrow(/NO soportado/i);
  });

  it('7.1.0 -> 26.2 avisa de saltos en orden pero NO de REQUIRES_VALIDATION', () => {
    const warnings = upgradePathWarnings(requireSupportedUpgradePath('7.1.0', '26.2')).join(' ');
    expect(warnings).toMatch(/3 saltos EN ORDEN/);
    expect(warnings).not.toMatch(/REQUIRES_VALIDATION/);
  });

  it('un origen < 7.x queda fuera de alcance (no soportado por este migrador)', () => {
    expect(() => requireSupportedUpgradePath('6.2', '26.2')).toThrow(/NO soportado/i);
    expect(() => requireSupportedUpgradePath('5.2', '26.2')).toThrow(/NO soportado/i);
  });

  it('una ruta directa soportada no avisa de saltos', () => {
    const warnings = upgradePathWarnings(requireSupportedUpgradePath('25.3', '26.2'));
    expect(warnings.some((w) => w.includes('saltos EN ORDEN'))).toBe(false);
  });

  it('gates y solrRemoval se evaluan desde la matriz', () => {
    expect(breakingChangeGates('26.2', 'EE')).toContain(upgradeMatrix().gates.find((g) => g.text.includes('Solr'))?.text);
    expect(requiresSolrRemoval('26.2', 'EE')).toBe(true);
    expect(breakingChangeGates('23.4', 'CE')).toEqual([upgradeMatrix().gatesFallback?.replace('$TO', '23.4')]);
  });
});
