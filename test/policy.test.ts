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

  it('guardrail: permite lectura/orquestacion y deniega ejecucion/mutacion', () => {
    // Denegadas (ejecucion / mutacion / red arbitraria).
    expect(decide({ name: 'bash' }, { guardrail: true }).kind).toBe('deny');
    expect(decide({ name: 'write' }, { guardrail: true }).kind).toBe('deny');
    expect(decide({ name: 'str_replace_editor' }, { guardrail: true }).kind).toBe('deny');
    expect(decide({ name: 'web_fetch' }, { guardrail: true }).kind).toBe('deny');
    // Permitidas (lectura).
    expect(decide({ name: 'read' }, { guardrail: true }).kind).toBe('allow');
    expect(decide({ name: 'grep' }, { guardrail: true }).kind).toBe('allow');
    // Permitidas (orquestacion / subagentes) y preguntas al humano.
    expect(decide({ name: 'subagent' }, { guardrail: true }).kind).toBe('allow');
    expect(decide({ name: 'send_message' }, { guardrail: true }).kind).toBe('allow');
    expect(decide({ name: 'todo_write' }, { guardrail: true }).kind).toBe('allow');
    expect(decide({ name: 'ask_user_question' }, { guardrail: true }).kind).toBe('allow');
    // Migrador: read-only allow, escritura ask.
    expect(decide({ name: 'migrator_coherence' }, { guardrail: true }).kind).toBe('allow');
    expect(decide({ name: 'migrator_run_steps' }, { guardrail: true }).kind).toBe('ask');
    // Ampliable por el usuario.
    expect(decide({ name: 'bash' }, { guardrail: true, allowTools: ['bash'] }).kind).toBe('allow');
  });

  it('policyOptionsFromEnv lee MIGRATOR_GUARDRAIL / _ALLOW (y alias STRICT_TOOLS)', () => {
    expect(policyOptionsFromEnv({}).guardrail).toBe(false);
    expect(policyOptionsFromEnv({ MIGRATOR_GUARDRAIL: 'true' }).guardrail).toBe(true);
    expect(policyOptionsFromEnv({ MIGRATOR_STRICT_TOOLS: '1' }).guardrail).toBe(true);
    expect(policyOptionsFromEnv({ MIGRATOR_GUARDRAIL: 'true', MIGRATOR_GUARDRAIL_ALLOW: 'bash,read' }).allowTools).toEqual([
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
