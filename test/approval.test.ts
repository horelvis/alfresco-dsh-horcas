import { describe, expect, it } from 'vitest';
import { decideApproval, optionsFromEnv } from '../src/approval.js';

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
