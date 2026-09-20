import { describe, expect, it } from 'vitest';
import { checkHopAlignment, nextHop, sameMinor } from '../src/domain/hops.js';
import { requireSupportedUpgradePath } from '../src/domain/upgrade-paths.js';

const hops = requireSupportedUpgradePath('7.1.0', '26.2'); // 3 hops
const allDone = new Set(hops.map((h) => h.to));

describe('guarda de hops (ruta multi-hop)', () => {
  it('con todos los hops hechos, el destino debe estar en la version final', () => {
    expect(checkHopAlignment(hops, allDone, '26.2.0', '26.2').ok).toBe(true);
  });

  it('primer hop: exige 7.4, no 26.2 (bloquea el salto directo)', () => {
    const alignment = checkHopAlignment(hops, new Set(), '26.2.0', '26.2');
    expect(alignment.ok).toBe(false);
    expect(alignment.expected).toBe('7.4');
    expect(alignment.reason).toMatch(/siguiente hop exige 7\.4/);
  });

  it('primer hop en 7.4 -> ok', () => {
    expect(checkHopAlignment(hops, new Set(), '7.4.0', '26.2').ok).toBe(true);
  });

  it('sin version del destino -> fail-closed', () => {
    const alignment = checkHopAlignment(hops, new Set(), undefined, '26.2');
    expect(alignment.ok).toBe(false);
    expect(alignment.reason).toMatch(/MIGRATOR_DST_BASE_URL/);
  });

  it('una ruta de un solo hop no aplica la guarda', () => {
    const one = requireSupportedUpgradePath('25.3', '26.2');
    expect(checkHopAlignment(one, new Set(), undefined, '26.2').ok).toBe(true);
  });

  it('nextHop devuelve el primer pendiente y sameMinor compara mayor.minor', () => {
    expect(nextHop(hops, new Set(['7.4']))?.to).toBe('25.3');
    expect(sameMinor('7.4.0', '7.4')).toBe(true);
    expect(sameMinor('7.4', '7.5')).toBe(false);
  });
});
