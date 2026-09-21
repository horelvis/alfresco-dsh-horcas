import { describe, expect, it } from 'vitest';
import { manualCommands, renderCompose, shouldSkipProvision, stopTargets } from '../src/domain/provision.js';
import { computeAlfrescoMemory, type MemoryData } from '../src/domain/memory.js';
import { evaluateUpgradeLog, waitForUpgrade } from '../src/domain/schema-upgrade.js';

const memoryData: MemoryData = { reservedGiB: 5, alfrescoShare: 0.5, minGiB: 2.5, maxGiB: 12, jvmMinPercent: 50, jvmMaxPercent: 75 };

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

  it('usa la memoria calculada por RAM disponible cuando se aporta', () => {
    const memory = computeAlfrescoMemory(16 * 1024 ** 3, memoryData);
    const yaml = renderCompose({ ...request, memory });
    expect(yaml).toContain('mem_limit: 5632m');
    expect(yaml).toContain('MaxRAMPercentage=75');
  });

  it('Solr no se despliega en destino', () => {
    expect(() => renderCompose({ ...request, search: { engine: 'solr' } })).toThrow();
  });

  it('con dataDir monta el content store y la BD en la carpeta del DESTINO (bind, sin volumenes con nombre)', () => {
    const yaml = renderCompose({ ...request, dataDir: '/data/alfresco-dst-v2' });
    expect(yaml).toContain('/data/alfresco-dst-v2/alf-data:/usr/local/tomcat/alf_data');
    expect(yaml).toContain('/data/alfresco-dst-v2/pg-data:/var/lib/postgresql/data');
    expect(yaml).not.toContain('alfresco-content:');
    expect(yaml).not.toContain('volumes:\n  alfresco-db:');
  });

  it('auto-skip: external siempre, auto solo si corre, managed nunca', () => {
    expect(shouldSkipProvision('external', false)).toBe(true);
    expect(shouldSkipProvision('auto', true)).toBe(true);
    expect(shouldSkipProvision('auto', false)).toBe(false);
    expect(shouldSkipProvision('managed', true)).toBe(false);
  });
});

describe('manualCommands (copiar y ejecutar en el destino, sin SSH)', () => {
  it('incluye carpetas, compose en base64, down y up con sudo', () => {
    const commands = manualCommands({ ...request, dataDir: '/data/v2' }, '/data/v2');
    expect(commands[0]).toContain('mkdir -p "/data/v2/alf-data" "/data/v2/pg-data"');
    expect(commands.some((c) => c.includes('base64 -d') && c.includes('tee /tmp/docker-compose-26.2.yml'))).toBe(true);
    expect(commands.some((c) => c.includes('docker compose -p "demo" down'))).toBe(true);
    expect(commands.some((c) => c.includes('docker compose -p "demo" -f /tmp/docker-compose-26.2.yml up -d'))).toBe(true);
  });
});

describe('stopTargets (que stacks parar antes de provisionar)', () => {
  it('con proyecto explicito, solo ese', () => {
    expect(stopTargets(['alfresco-dst', 'otra'], 'alfresco-dst')).toEqual(['alfresco-dst']);
  });

  it('sin explicito, los que parezcan de Alfresco', () => {
    expect(stopTargets(['alfresco-dst', 'web', 'alfresco-demo'])).toEqual(['alfresco-dst', 'alfresco-demo']);
  });

  it('sin coincidencias, solo si hay un unico proyecto', () => {
    expect(stopTargets(['web'])).toEqual(['web']);
    expect(stopTargets(['web', 'api'])).toEqual([]);
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
