import { describe, expect, it } from 'vitest';
import { assertOneShot, decideApproval, installApproval, isDelegated, optionsFromEnv, type ApprovalOutcome } from '../src/approval.js';

type Handler = (request: { toolName: string; agent?: unknown }, next: () => Promise<ApprovalOutcome>) => Promise<ApprovalOutcome | undefined>;

function fakeCtx(): { handler: Handler } {
  const holder: { handler?: Handler } = {};
  const ctx = {
    on: (_event: string, handler: Handler) => {
      holder.handler = handler;
      return undefined;
    },
  };
  installApproval(ctx as never, { mode: 'allowlist', allow: ['migrator_run_steps'] });
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
});

describe('handler de aprobacion (sin bloquear subagentes ni tools ajenas)', () => {
  it('las tools ajenas se delegan al arnes/la UI', async () => {
    const { handler } = fakeCtx();
    expect(await handler({ toolName: 'bash' }, async () => 'allowed-once')).toBe('allowed-once');
    expect(await handler({ toolName: 'write' }, async () => 'rejected')).toBe('rejected');
  });

  it('una tool del migrador en subagente se rechaza (no hereda)', async () => {
    const { handler } = fakeCtx();
    expect(await handler({ toolName: 'migrator_run_steps', agent: { parentAgent: {} } }, async () => 'allowed-once')).toBe('rejected');
  });

  it('la tool del migrador permitida en el agente raiz se concede', async () => {
    const { handler } = fakeCtx();
    expect(await handler({ toolName: 'migrator_run_steps' }, async () => 'rejected')).toBe('allowed-once');
  });
});
