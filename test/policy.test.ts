import { describe, expect, it } from 'vitest';
import { decide, guardReason, policyOptionsFromEnv, writeReason } from '../src/security/policy.js';

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

  it('solo-lectura: deniega escritura del migrador; read-only sigue permitido', () => {
    expect(decide({ name: 'migrator_run_steps' }, { readOnly: true }).kind).toBe('deny');
    expect(decide({ name: 'migrator_target' }, { readOnly: true }).kind).toBe('deny');
    expect(decide({ name: 'migrator_coherence' }, { readOnly: true }).kind).toBe('allow');
    // Con escritura habilitada, pide aprobacion.
    expect(decide({ name: 'migrator_run_steps' }, { readOnly: false }).kind).toBe('ask');
  });

  it('MIGRATOR_MODE por defecto readonly; write lo desbloquea', () => {
    expect(policyOptionsFromEnv({}).readOnly).toBe(true);
    expect(policyOptionsFromEnv({ MIGRATOR_MODE: 'write' }).readOnly).toBe(false);
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

  it('el motivo de aprobacion es descriptivo (proyecto, pasos, execute)', () => {
    expect(writeReason('migrator_provision', { project: '/p/gadex.yaml', execute: true })).toMatch(
      /gadex\.yaml.*EXECUTE/s,
    );
    const run = writeReason('migrator_run_steps', { project: 'x', steps: ['copy-content', 'reindex'], execute: false });
    expect(run).toContain('copy-content, reindex');
    expect(run).toContain('dry-run');
    const decision = decide({ name: 'migrator_target', arguments: { project: '/p.yaml' } });
    expect(decision.kind).toBe('ask');
    expect((decision as { reason: string }).reason).toContain('/p.yaml');
  });

  it('el guard bloquea escritura sobre el origen', () => {
    expect(guardReason({ name: 'migrator_run_steps', arguments: { origin: true } })).toBeTruthy();
    expect(guardReason({ name: 'migrator_run_steps', arguments: {} })).toBeUndefined();
    expect(guardReason({ name: 'migrator_schema_check' })).toBeUndefined();
  });
});
