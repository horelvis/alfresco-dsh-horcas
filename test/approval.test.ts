import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assertOneShot,
  blocksDelegatedWrite,
  decideApproval,
  installApproval,
  isDelegated,
  optionsFromEnv,
  type ApprovalOutcome,
} from '../src/approval.js';

type Handler = (request: { toolName: string; agent?: unknown }, next: () => Promise<ApprovalOutcome>) => Promise<ApprovalOutcome | undefined>;

/** Estado temporal: la auditoria de aprobacion no debe ensuciar el `.migrator/` del repo. */
const auditState = mkdtempSync(path.join(tmpdir(), 'migrator-approval-'));

function fakeCtx(mode: 'allowlist' | 'interactive' = 'allowlist', allow: string[] = ['migrator_run_steps']): { handler: Handler } {
  const holder: { handler?: Handler } = {};
  const ctx = {
    on: (_event: string, handler: Handler) => {
      holder.handler = handler;
      return undefined;
    },
  };
  installApproval(ctx as never, { mode, allow, state: auditState });
  return { handler: holder.handler as Handler };
}

describe('optionsFromEnv', () => {
  it('por defecto deny (fail-closed)', () => {
    expect(optionsFromEnv({}).mode).toBe('deny');
  });
  it('parsea allowlist', () => {
    const options = optionsFromEnv({ MIGRATOR_APPROVAL: 'allowlist', MIGRATOR_APPROVAL_ALLOW: 'migrator_run_steps, migrator_target' });
    expect(options.mode).toBe('allowlist');
    expect(options.allow).toEqual(['migrator_run_steps', 'migrator_target']);
  });
  it('modo invalido cae a deny', () => {
    expect(optionsFromEnv({ MIGRATOR_APPROVAL: 'banana' }).mode).toBe('deny');
  });
});

describe('decideApproval', () => {
  it('deny rechaza', () => {
    expect(decideApproval({ toolName: 'migrator_run_steps' }, { mode: 'deny', allow: [] })).toBe('rejected');
  });
  it('allow concede allowed-once', () => {
    expect(decideApproval({ toolName: 'migrator_run_steps' }, { mode: 'allow', allow: [] })).toBe('allowed-once');
  });
  it('allowlist solo permite lo listado', () => {
    const options = { mode: 'allowlist' as const, allow: ['migrator_run_steps'] };
    expect(decideApproval({ toolName: 'migrator_run_steps' }, options)).toBe('allowed-once');
    expect(decideApproval({ toolName: 'migrator_target' }, options)).toBe('rejected');
  });
});

describe('solo concesiones one-shot', () => {
  it('allowed-once es valido', () => {
    expect(assertOneShot('allowed-once')).toBe('allowed-once');
  });
  it('cualquier grant persistente se rechaza', () => {
    for (const grant of ['always', 'remember', 'session', 'persist']) {
      expect(() => assertOneShot(grant as never)).toThrow();
    }
  });
});

describe('sin autorizaciones heredadas en cadena', () => {
  it('el agente raiz no es delegado', () => {
    expect(isDelegated(undefined)).toBe(false);
    expect(isDelegated({})).toBe(false);
    expect(isDelegated({ meta: { origin: 'user' } })).toBe(false);
  });
  it('un subagente (parentAgent/origin/delegationDepth) si lo es', () => {
    expect(isDelegated({ parentAgent: {} })).toBe(true);
    expect(isDelegated({ meta: { origin: 'subagent' } })).toBe(true);
    expect(isDelegated({ meta: { delegationDepth: 2 } })).toBe(true);
  });
  it('solo bloquea escritura, solo en modos no interactivos', () => {
    const sub = { parentAgent: {} };
    // Escritura en allowlist: bloqueada.
    expect(blocksDelegatedWrite('migrator_run_steps', sub, 'allowlist')).toBe(true);
    // Escritura en interactive: NO se bloquea (grant one-shot por llamada).
    expect(blocksDelegatedWrite('migrator_run_steps', sub, 'interactive')).toBe(false);
    // Read-only: nunca se bloquea.
    expect(blocksDelegatedWrite('migrator_schema_check', sub, 'allowlist')).toBe(false);
    // Raiz: nunca se bloquea.
    expect(blocksDelegatedWrite('migrator_run_steps', undefined, 'allowlist')).toBe(false);
  });
});

describe('handler de aprobacion (sin bloquear subagentes ni tools ajenas)', () => {
  it('las tools ajenas se delegan al arnes/la UI', async () => {
    const { handler } = fakeCtx();
    expect(await handler({ toolName: 'bash' }, async () => 'allowed-once')).toBe('allowed-once');
    expect(await handler({ toolName: 'write' }, async () => 'rejected')).toBe('rejected');
  });

  it('en allowlist, una escritura del migrador en subagente se rechaza', async () => {
    const { handler } = fakeCtx('allowlist');
    expect(await handler({ toolName: 'migrator_run_steps', agent: { parentAgent: {} } }, async () => 'allowed-once')).toBe('rejected');
  });

  it('en allowlist, un read-only del migrador en subagente NO se bloquea por delegacion', async () => {
    const { handler } = fakeCtx('allowlist', ['migrator_schema_check']);
    expect(await handler({ toolName: 'migrator_schema_check', agent: { parentAgent: {} } }, async () => 'rejected')).toBe('allowed-once');
  });

  it('en interactive sin TTY delega en el siguiente answerer (perfil web)', async () => {
    // Sin TTY no hay prompt por stdin: se delega en la UI del arnes (no se bloquea por delegacion).
    const { handler } = fakeCtx('interactive');
    expect(await handler({ toolName: 'migrator_run_steps', agent: { parentAgent: {} } }, async () => 'allowed-once')).toBe('allowed-once');
    expect(await handler({ toolName: 'migrator_run_steps' }, async () => 'rejected')).toBe('rejected');
  });

  it('la tool del migrador permitida en el agente raiz se concede', async () => {
    const { handler } = fakeCtx();
    expect(await handler({ toolName: 'migrator_run_steps' }, async () => 'rejected')).toBe('allowed-once');
  });
});
