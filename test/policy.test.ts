import { describe, expect, it } from 'vitest';
import { decide, guardReason, policyOptionsFromEnv } from '../src/security/policy.js';

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

  it('modo solo-migracion: deniega tools ajenas, permite las del migrador y ask_user', () => {
    expect(decide({ name: 'bash' }, { strictTools: true }).kind).toBe('deny');
    expect(decide({ name: 'write' }, { strictTools: true }).kind).toBe('deny');
    expect(decide({ name: 'ask_user' }, { strictTools: true }).kind).toBe('allow');
    expect(decide({ name: 'migrator_coherence' }, { strictTools: true }).kind).toBe('allow');
    expect(decide({ name: 'migrator_run_steps' }, { strictTools: true }).kind).toBe('ask');
    expect(decide({ name: 'bash' }, { strictTools: true, allowTools: ['bash'] }).kind).toBe('allow');
  });

  it('policyOptionsFromEnv lee MIGRATOR_STRICT_TOOLS / MIGRATOR_STRICT_ALLOW', () => {
    expect(policyOptionsFromEnv({}).strictTools).toBe(false);
    expect(policyOptionsFromEnv({ MIGRATOR_STRICT_TOOLS: 'true' }).strictTools).toBe(true);
    expect(policyOptionsFromEnv({ MIGRATOR_STRICT_TOOLS: '1', MIGRATOR_STRICT_ALLOW: 'bash,read' }).allowTools).toEqual([
      'ask_user',
      'bash',
      'read',
    ]);
  });

  it('el guard bloquea escritura sobre el origen', () => {
    expect(guardReason({ name: 'migrator_run_steps', arguments: { origin: true } })).toBeTruthy();
    expect(guardReason({ name: 'migrator_run_steps', arguments: {} })).toBeUndefined();
    expect(guardReason({ name: 'migrator_schema_check' })).toBeUndefined();
  });
});
