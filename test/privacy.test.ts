import { describe, expect, it } from 'vitest';
import {
  Anonymizer,
  detectorsFor,
  policyFromEnv,
  ResidualPiiScanner,
  SECRETS_ONLY,
  STANDARD,
} from '../src/domain/privacy.js';

describe('anonymizer', () => {
  it('tokeniza de forma determinista y reversible', () => {
    const anon = new Anonymizer([], STANDARD);
    const a = anon.anonymize('email a@b.com y otra vez a@b.com');
    expect(a).toContain('<EMAIL_1>');
    expect((a?.match(/<EMAIL_1>/g) ?? []).length).toBe(2);
    expect(anon.deAnonymize(a)).toContain('a@b.com');
  });

  it('SECRETS_ONLY no toca emails pero si secretos', () => {
    const anon = new Anonymizer([], SECRETS_ONLY);
    const text = anon.anonymize('password=SuperSecreto123 user a@b.com') ?? '';
    expect(text).not.toContain('SuperSecreto123');
    expect(text).toContain('a@b.com');
  });

  it('STANDARD tokeniza nodeRef, jdbc, uuid e IP', () => {
    const anon = new Anonymizer([], STANDARD);
    const text = anon.anonymize('workspace://SpacesStore/3ae504c6-d01f-4233-8765-aef2a3b65dc4 jdbc:postgresql://10.0.0.5:5432/alfresco') ?? '';
    expect(text).not.toContain('SpacesStore');
    expect(text).not.toContain('10.0.0.5');
  });

  it('valores conocidos se tokenizan siempre', () => {
    const anon = new Anonymizer(['SuperSecretoLocal'], SECRETS_ONLY);
    expect(anon.anonymize('x SuperSecretoLocal y')).toContain('<KNOWN_1>');
  });

  it('mapea token -> original solo en local', () => {
    const anon = new Anonymizer([], STANDARD);
    anon.anonymize('a@b.com');
    expect(anon.mapping()).toMatchObject({ '<EMAIL_1>': 'a@b.com' });
  });
});

describe('residual PII scanner', () => {
  it('detecta PII residual por categoria', () => {
    const scanner = new ResidualPiiScanner();
    expect(scanner.isClean('texto limpio sin datos')).toBe(true);
    expect(scanner.scan('contacto a@b.com')).toContain('EMAIL');
  });
});

describe('politica', () => {
  it('por defecto SECRETS_ONLY y detectores por politica', () => {
    expect(policyFromEnv({})).toBe('SECRETS_ONLY');
    expect(detectorsFor('OFF')).toHaveLength(0);
    expect(detectorsFor('STANDARD').length).toBeGreaterThan(detectorsFor('SECRETS_ONLY').length);
  });
});
