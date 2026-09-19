import { describe, expect, it } from 'vitest';
import { renderCompose, shouldSkipProvision } from '../src/domain/provision.js';
import { evaluateUpgradeLog, waitForUpgrade } from '../src/domain/schema-upgrade.js';

const request = {
  projectName: 'demo',
  acsVersion: '26.2',
  edition: 'CE',
  deployment: 'compose',
  database: { engine: 'postgresql', host: 'db', port: 5432, name: 'alfresco', user: 'alfresco' },
  search: { engine: 'opensearch' },
};

describe('compose', () => {
  it('genera el compose con postgres/activemq/search/alfresco y sin secretos embebidos', () => {
    const yaml = renderCompose(request);
    expect(yaml).toContain('image: postgres:15');
    expect(yaml).toContain('alfresco/alfresco-activemq:5.18.6');
    expect(yaml).toContain('opensearchproject/opensearch');
    expect(yaml).toContain('alfresco/alfresco-content-repository-community:26.2');
    expect(yaml).toContain('${POSTGRES_PASSWORD}');
    expect(yaml).toContain('jdbc:postgresql://postgres:5432/alfresco');
  });

  it('EE usa la imagen enterprise y share opcional', () => {
    const yaml = renderCompose({ ...request, edition: 'EE', withShare: true });
    expect(yaml).toContain('quay.io/alfresco/alfresco-content-repository:26.2');
    expect(yaml).toContain('alfresco/alfresco-share:26.2');
  });

  it('Solr no se despliega en destino', () => {
    expect(() => renderCompose({ ...request, search: { engine: 'solr' } })).toThrow();
  });

  it('auto-skip: external siempre, auto solo si corre, managed nunca', () => {
    expect(shouldSkipProvision('external', false)).toBe(true);
    expect(shouldSkipProvision('auto', true)).toBe(true);
    expect(shouldSkipProvision('auto', false)).toBe(false);
    expect(shouldSkipProvision('managed', true)).toBe(false);
  });
});

describe('schema-upgrade', () => {
  it('detecta exito por marcador', () => {
    expect(evaluateUpgradeLog('7.4', 'INFO Database schema version: 5026').applied).toBe(true);
    expect(evaluateUpgradeLog('7.4', 'Alfresco started').applied).toBe(true);
  });

  it('detecta error', () => {
    const result = evaluateUpgradeLog('7.4', 'FATAL: no se pudo');
    expect(result.applied).toBe(false);
    expect(result.error).toBe('FATAL');
  });

  it('sin marcador no aplica', () => {
    expect(evaluateUpgradeLog('7.4', 'arrancando...').applied).toBe(false);
  });

  it('waitForUpgrade sondea hasta exito', async () => {
    let calls = 0;
    const probe = async (): Promise<string> => {
      calls++;
      return calls < 3 ? 'arrancando' : 'Alfresco started';
    };
    const result = await waitForUpgrade('26.2', probe, { timeoutMs: 1000, intervalMs: 1, sleep: async () => undefined });
    expect(result.applied).toBe(true);
    expect(calls).toBe(3);
  });
});
