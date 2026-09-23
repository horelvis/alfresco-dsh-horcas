import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  composeImages,
  composeProjectName,
  ensureStackSecrets,
  globalProperties,
  isPrereleaseImage,
  manualCommands,
  manualCommandsForFile,
  renderCompose,
  shouldSkipProvision,
  stopTargets,
} from '../src/domain/provision.js';
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
    // Tags EXACTOS (los genericos no existen en el registro).
    expect(yaml).toContain('alfresco/alfresco-activemq:6.2.9-jre17-rockylinux8');
    expect(yaml).toContain('opensearchproject/opensearch');
    expect(yaml).toContain('alfresco/alfresco-content-repository-community:26.2.0');
    expect(yaml).toContain('${POSTGRES_PASSWORD}');
    expect(yaml).toContain('jdbc:postgresql://postgres:5432/alfresco');
  });

  it('7.x usa la serie ActiveMQ 5.18.7 y repo con patch .0', () => {
    const yaml = renderCompose({ ...request, acsVersion: '7.4' });
    expect(yaml).toContain('alfresco/alfresco-activemq:5.18.7-jre17-rockylinux8');
    expect(yaml).toContain('alfresco/alfresco-content-repository-community:7.4.0');
  });

  it('acsImage (exacta) manda sobre edition+version', () => {
    const yaml = renderCompose({ ...request, acsImage: 'alfresco/alfresco-content-repository-community:7.4.2' });
    expect(yaml).toContain('alfresco/alfresco-content-repository-community:7.4.2');
  });

  it('EE usa la imagen enterprise y share opcional', () => {
    const yaml = renderCompose({ ...request, edition: 'EE', withShare: true });
    expect(yaml).toContain('quay.io/alfresco/alfresco-content-repository:26.2.0');
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

  it('con dataDir monta el content store en bind y la BD en volumen (evita permisos en macOS)', () => {
    const yaml = renderCompose({ ...request, dataDir: '/data/alfresco-dst-v2' });
    expect(yaml).toContain('/data/alfresco-dst-v2/alf-data:/usr/local/tomcat/alf_data');
    expect(yaml).toContain('alfresco-db:/var/lib/postgresql/data');
    expect(yaml).not.toContain('alfresco-content:');
  });

  it('con dataDir monta alfresco-global.properties generado (la imagen 7.4 arranca con el vacio)', () => {
    const yaml = renderCompose({ ...request, dataDir: '/data/alfresco-dst-v2' });
    expect(yaml).toContain(
      '/data/alfresco-dst-v2/config/alfresco-global.properties:/usr/local/tomcat/shared/classes/alfresco-global.properties:ro',
    );
  });

  it('con dataDir + pgBind monta tambien la BD en la carpeta del DESTINO', () => {
    const yaml = renderCompose({ ...request, dataDir: '/data/alfresco-dst-v2', pgBind: true });
    expect(yaml).toContain('/data/alfresco-dst-v2/pg-data:/var/lib/postgresql/data');
  });

  it('auto-skip: external siempre, auto solo si corre, managed nunca', () => {
    expect(shouldSkipProvision('external', false)).toBe(true);
    expect(shouldSkipProvision('auto', true)).toBe(true);
    expect(shouldSkipProvision('auto', false)).toBe(false);
    expect(shouldSkipProvision('managed', true)).toBe(false);
  });
});

describe('manualCommands (copiar y ejecutar en el destino, sin SSH)', () => {
  it('copia stack.env y usa --env-file, sin exponer secretos', () => {
    const commands = manualCommands({ ...request, dataDir: '/data/v2' }, '/data/v2');
    expect(commands[0]).toContain('scp .migrator/provision/stack.env');
    expect(commands.some((c) => c.includes('mkdir -p "/data/v2/alf-data"'))).toBe(true);
    expect(commands.some((c) => c.includes('base64 -d') && c.includes('tee /tmp/docker-compose-26.2.yml'))).toBe(true);
    expect(commands.some((c) => c.includes('docker compose -p "demo" down'))).toBe(true);
    expect(
      commands.some((c) => c.includes('--env-file /tmp/demo.env') && c.includes('-f /tmp/docker-compose-26.2.yml up -d')),
    ).toBe(true);
    expect(commands.join(' ')).not.toMatch(/POSTGRES_PASSWORD=/);
  });
});

describe('manualCommandsForFile (compose del operador, sin generar ni copiar)', () => {
  it('usa el fichero tal cual y levanta solo la infra, sin -p ni base64', () => {
    const commands = manualCommandsForFile('/home/op/infra/alfresco/docker-compose.yml');
    expect(commands).toEqual([
      'sudo docker compose -f "/home/op/infra/alfresco/docker-compose.yml" down --remove-orphans',
      'sudo docker compose -f "/home/op/infra/alfresco/docker-compose.yml" up -d postgres activemq search',
    ]);
    expect(commands.join(' ')).not.toContain('base64');
    expect(commands.join(' ')).not.toContain(' -p ');
  });
});

describe('composeProjectName', () => {
  it('quita los puntos (nombre de proyecto invalido) y normaliza', () => {
    expect(composeProjectName('gadex-7.1.0')).toBe('gadex-7-1-0');
    expect(composeProjectName('Gadex 7.1.0')).toBe('gadex-7-1-0');
    expect(composeProjectName('...')).toBe('alfresco');
  });
});

describe('composeImages', () => {
  it('incluye repo, activemq, db y search con tags exactos', () => {
    const images = composeImages(request);
    expect(images).toContain('postgres:15');
    expect(images).toContain('alfresco/alfresco-activemq:6.2.9-jre17-rockylinux8');
    expect(images).toContain('alfresco/alfresco-content-repository-community:26.2.0');
  });
});

describe('isPrereleaseImage', () => {
  it('detecta pre-release y acepta GA', () => {
    expect(isPrereleaseImage('alfresco/alfresco-content-repository-community:7.4.2.5-A1')).toBe(true);
    expect(isPrereleaseImage('alfresco/alfresco-content-repository-community:26.2.0-RC1')).toBe(true);
    expect(isPrereleaseImage('repo:1.0-SNAPSHOT')).toBe(true);
    expect(isPrereleaseImage('alfresco/alfresco-content-repository-community:7.4.2')).toBe(false);
    expect(isPrereleaseImage('alfresco/alfresco-content-repository-community:26.2.0')).toBe(false);
  });
});

describe('globalProperties', () => {
  it('incluye la config de BD con el password del stack y dir.root', () => {
    const props = globalProperties(request, { POSTGRES_PASSWORD: 'secret' });
    expect(props).toContain('db.url=jdbc:postgresql://postgres:5432/alfresco');
    expect(props).toContain('db.username=alfresco');
    expect(props).toContain('db.password=secret');
    expect(props).toContain('dir.root=/usr/local/tomcat/alf_data');
  });
});

describe('ensureStackSecrets', () => {
  it('genera secretos una vez y los reutiliza', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'prov-'));
    const first = await ensureStackSecrets(dir);
    expect(first.POSTGRES_PASSWORD).toMatch(/^[0-9a-f]{24}$/);
    expect(first.ACTIVEMQ_ADMIN_LOGIN).toBe('admin');
    const second = await ensureStackSecrets(dir);
    expect(second.POSTGRES_PASSWORD).toBe(first.POSTGRES_PASSWORD);
    await rm(dir, { recursive: true, force: true });
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
