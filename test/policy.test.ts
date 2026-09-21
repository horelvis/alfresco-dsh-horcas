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

  it('guardrail: permite lectura/ejecucion/orquestacion y deniega red arbitraria', () => {
    // Ejecucion/mutacion: permitidas; las gobierna el sandbox `read-only` + aprobacion del arnes.
    expect(decide({ name: 'bash' }, { guardrail: true }).kind).toBe('allow');
    expect(decide({ name: 'pwsh' }, { guardrail: true }).kind).toBe('allow');
    expect(decide({ name: 'write' }, { guardrail: true }).kind).toBe('allow');
    expect(decide({ name: 'str_replace_editor' }, { guardrail: true }).kind).toBe('allow');
    // Denegada (red arbitraria).
    expect(decide({ name: 'web_fetch' }, { guardrail: true }).kind).toBe('deny');
    expect(decide({ name: 'web_search' }, { guardrail: true }).kind).toBe('deny');
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

  it('la aprobacion dice el ENTORNO real (ENSAYO vs PROD)', () => {
    const test = decide({ name: 'migrator_run_steps', arguments: { steps: ['preflight-target'] } }, {}, 'Ejecuta pasos', 'test') as { details: string[] };
    expect(test.details.join(' ')).toMatch(/ENSAYO \(stage=test/);
    const prod = decide({ name: 'migrator_run_steps', arguments: { steps: ['preflight-target'] } }, {}, 'Ejecuta pasos', 'prod') as { details: string[] };
    expect(prod.details.join(' ')).toMatch(/PRODUCCION/);
  });

  it('el motivo es estructurado (title/details/body) reutilizando las descripciones', () => {
    const prov = writeReason(
      'migrator_provision',
      { project: '/p/gadex.yaml', execute: true },
      'Provisiona el DESTINO en Docker Compose.',
    );
    expect(prov.title).toContain('Provisiona el DESTINO en Docker Compose');
    expect(prov.details.join(' ')).toContain('/p/gadex.yaml');
    expect(prov.details.join(' ')).toContain('EXECUTE');
    expect(prov.body).toContain('ORIGEN');
    expect(prov.reason).not.toContain('\n');

    const run = writeReason(
      'migrator_run_steps',
      { project: 'x', steps: ['copy-content', 'reindex'], execute: false },
      'Ejecuta una composicion de pasos en el DESTINO.',
    );
    const runDetails = run.details.join(' | ');
    expect(runDetails).toContain('copy-content — Copia el content store del origen al destino');
    expect(runDetails).toContain('reindex — Regenera el indice de busqueda del destino');
    expect(runDetails).toContain('dry-run');

    const decision = decide(
      { name: 'migrator_target', arguments: { project: '/p.yaml' } },
      {},
      'Prepara el DESTINO para la migracion.',
    );
    expect(decision.kind).toBe('ask');
    const ask = decision as { title?: string; details?: string[]; body?: string };
    expect(ask.title).toContain('Prepara el DESTINO');
    expect((ask.details ?? []).join(' ')).toContain('/p.yaml');
    expect(ask.body).toContain('ORIGEN');
  });

  it('el guard bloquea escritura sobre el origen', () => {
    expect(guardReason({ name: 'migrator_run_steps', arguments: { origin: true } })).toBeTruthy();
    expect(guardReason({ name: 'migrator_run_steps', arguments: {} })).toBeUndefined();
    expect(guardReason({ name: 'migrator_schema_check' })).toBeUndefined();
  });
});
