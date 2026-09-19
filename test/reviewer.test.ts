import { describe, expect, it } from 'vitest';
import { buildUserPrompt, review } from '../src/domain/reviewer.js';

const request = { stage: 'PLAN' as const, project: 'demo', artifacts: { plan: 'contenido' } };

describe('reviewer', () => {
  it('sin cliente LLM -> ABSTAIN (no aprueba)', async () => {
    const report = await review(request, {});
    expect(report.verdict).toBe('ABSTAIN');
  });

  it('parsea una respuesta valida', async () => {
    const client = async () => JSON.stringify({
      verdict: 'APPROVE_WITH_CONDITIONS',
      confidence: 0.8,
      summary: 'ok',
      findings: [{ id: 'F1', severity: 'HIGH', title: 'dangling', detail: 'x', recommendation: 'y' }],
      conditions: ['resolver dangling'],
    });
    const report = await review(request, { client, policy: 'SECRETS_ONLY' });
    expect(report.verdict).toBe('APPROVE_WITH_CONDITIONS');
    expect(report.findings[0]?.severity).toBe('HIGH');
    expect(report.conditions).toContain('resolver dangling');
  });

  it('respuesta no JSON -> ABSTAIN', async () => {
    const client = async () => 'esto no es json';
    expect((await review(request, { client })).verdict).toBe('ABSTAIN');
  });

  it('LLM que lanza -> ABSTAIN', async () => {
    const client = async () => { throw new Error('timeout'); };
    expect((await review(request, { client })).verdict).toBe('ABSTAIN');
  });

  it('anonimiza los datos antes de enviarlos al LLM', async () => {
    let seen = '';
    const client = async (_system: string, user: string) => {
      seen = user;
      return JSON.stringify({ verdict: 'APPROVE', confidence: 1, summary: '', findings: [], conditions: [] });
    };
    await review({ ...request, artifacts: { log: 'password=SuperSecreto123 y a@b.com' } }, { client, policy: 'SECRETS_ONLY' });
    expect(seen).not.toContain('SuperSecreto123');
    expect(seen).toContain('a@b.com'); // SECRETS_ONLY no toca emails
  });

  it('buildUserPrompt incluye etapa y artefactos', () => {
    expect(buildUserPrompt(request)).toContain('PLAN');
    expect(buildUserPrompt(request)).toContain('### plan');
  });
});
