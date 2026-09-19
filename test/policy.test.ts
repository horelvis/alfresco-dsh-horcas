import { describe, expect, it } from 'vitest';
import { decide, guardReason } from '../src/security/policy.js';

describe('politica de seguridad', () => {
  it('read-only se permite', () => {
    expect(decide({ name: 'migrator_schema_check' }).kind).toBe('allow');
    expect(decide({ name: 'migrator_coherence' }).kind).toBe('allow');
  });

  it('escritura requiere aprobacion (ask)', () => {
    expect(decide({ name: 'migrator_run_steps' }).kind).toBe('ask');
    expect(decide({ name: 'migrator_target' }).kind).toBe('ask');
  });

  it('tool desconocida del plugin se deniega', () => {
    expect(decide({ name: 'migrator_hack' }).kind).toBe('deny');
  });

  it('tools ajenas al plugin se delegan', () => {
    expect(decide({ name: 'bash' }).kind).toBe('allow');
  });

  it('el guard bloquea escritura sobre el origen', () => {
    expect(guardReason({ name: 'migrator_run_steps', arguments: { origin: true } })).toBeTruthy();
    expect(guardReason({ name: 'migrator_run_steps', arguments: {} })).toBeUndefined();
    expect(guardReason({ name: 'migrator_schema_check' })).toBeUndefined();
  });
});
