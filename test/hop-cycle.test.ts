import { describe, expect, it } from 'vitest';
import { hopGuardApplies, pendingHopVersion } from '../src/domain/hops.js';
import { requireSupportedUpgradePath } from '../src/domain/upgrade-paths.js';
import { evaluateSmoke } from '../src/domain/schema-upgrade.js';
import { projectToComposeRequest } from '../src/domain/provision.js';
import { STEPS } from '../src/domain/steps.js';
import type { ProjectConfig } from '../src/domain/project-config.js';

const hops = requireSupportedUpgradePath('7.1.0', '26.2');

describe('ciclo por hop', () => {
  it('hop pendiente: 7.4, luego 25.3, luego la version final', () => {
    expect(pendingHopVersion(hops, new Set(), '26.2')).toBe('7.4');
    expect(pendingHopVersion(hops, new Set(['7.4']), '26.2')).toBe('25.3');
    expect(pendingHopVersion(hops, new Set(hops.map((h) => h.to)), '26.2')).toBe('26.2');
  });

  it('la guarda previa solo se omite si la composicion empieza por provision-hop', () => {
    expect(hopGuardApplies(['provision-hop', 'restore-target-db', 'schema-upgrade', 'smoke-boot'])).toBe(false);
    expect(hopGuardApplies(['restore-target-db', 'provision-hop'])).toBe(true);
    expect(hopGuardApplies(['schema-upgrade'])).toBe(true);
  });

  it('provision-hop y smoke-boot estan en el catalogo; solo provision-hop escribe', () => {
    expect(STEPS.find((s) => s.id === 'provision-hop')?.writes).toBe(true);
    expect(STEPS.find((s) => s.id === 'smoke-boot')?.writes).toBe(false);
  });

  it('target.acsImage solo se aplica al hop cuya version casa con su tag', () => {
    const final = { project: 'g', target: { version: '26.2', acsImage: 'alfresco/alfresco-content-repository-community:26.2.0' } } as unknown as ProjectConfig;
    expect(projectToComposeRequest(final, '7.4', false).acsImage).toBeUndefined();
    expect(projectToComposeRequest(final, '26.2', false).acsImage).toBe(final.target.acsImage);
    const hop74 = { project: 'g', target: { version: '26.2', acsImage: 'alfresco/alfresco-content-repository-community:7.4.2' } } as unknown as ProjectConfig;
    expect(projectToComposeRequest(hop74, '7.4', false).acsImage).toBe(hop74.target.acsImage);
    expect(projectToComposeRequest(hop74, '25.3', false).acsImage).toBeUndefined();
  });
});

describe('smoke del hop (fail-closed)', () => {
  const base = { hop: '7.4', version: '7.4.2', rootCode: '200', log: 'Started RepoServer' };

  it('ok con version del hop, raiz 2xx y log limpio', () => {
    expect(evaluateSmoke(base).ok).toBe(true);
  });

  it('falla si la version no es la del hop', () => {
    expect(evaluateSmoke({ ...base, version: '26.2.0' }).reason).toMatch(/responde en 26\.2\.0/);
  });

  it('falla sin version (discovery inaccesible)', () => {
    expect(evaluateSmoke({ ...base, version: undefined }).ok).toBe(false);
  });

  it('falla si la raiz no resuelve', () => {
    expect(evaluateSmoke({ ...base, rootCode: '500' }).reason).toMatch(/raiz no resuelve/);
  });

  it('falla con errores de esquema en el log', () => {
    expect(evaluateSmoke({ ...base, log: 'Schema patch failed: foo' }).ok).toBe(false);
  });
});

describe('compose generado', () => {
  it('lleva la cabecera que permite regenerarlo (el del operador nunca)', async () => {
    const { GENERATED_MARKER, renderCompose } = await import('../src/domain/provision.js');
    const yaml = renderCompose({ projectName: 'acme-710', acsVersion: '25.3', edition: 'CE', deployment: 'compose', database: { engine: 'postgresql' }, search: { engine: 'ELASTICSEARCH' }, dataDir: '/d', pgBind: true });
    expect(yaml.split('\n')[0]).toBe(GENERATED_MARKER);
    expect(yaml).toContain('/d/pg-data:/var/lib/postgresql/data');
    expect(yaml).toContain('alfresco-content-repository-community:25.3.0');
    expect(yaml).toContain('xpack.security.enabled: "false"');
  });
});

describe('writeComposeRemote (nunca pisa el compose del operador)', () => {
  it('regenera si es identico a la copia generada; respeta uno editado a mano', async () => {
    const { mkdtemp, readFile, writeFile } = await import('node:fs/promises');
    const os = await import('node:os');
    const path = await import('node:path');
    const { writeComposeRemote } = await import('../src/domain/provision.js');
    const dir = await mkdtemp(path.join(os.tmpdir(), 'compose-'));
    const generated = path.join(dir, 'gen.yml');
    const operator = path.join(dir, 'op.yml');
    await writeFile(generated, 'old: generado\n');
    await writeFile(operator, 'old: operador\n');
    await writeComposeRemote({ name: 'local' }, generated, 'new: 1\n', 'old: generado\n');
    await writeComposeRemote({ name: 'local' }, operator, 'new: 1\n', 'old: generado\n');
    expect(await readFile(generated, 'utf8')).toBe('new: 1\n');
    expect(await readFile(operator, 'utf8')).toBe('old: operador\n');
  });
});

describe('keystore de metadatos por defecto', () => {
  it('va en alfresco-global.properties y como JAVA_TOOL_OPTIONS en el compose generado', async () => {
    const { defaultKeystore, globalProperties, renderCompose } = await import('../src/domain/provision.js');
    const request = { projectName: 'p', acsVersion: '7.4', edition: 'CE', deployment: 'compose', database: { engine: 'postgresql' }, dataDir: '/d' };
    const props = globalProperties(request, { POSTGRES_PASSWORD: 'x' });
    for (const [key, value] of Object.entries(defaultKeystore())) expect(props).toContain(`${key}=${value}`);
    expect(props).toContain('encryption.keystore.type=JCEKS');
    const yaml = renderCompose(request);
    expect(yaml).toContain('JAVA_TOOL_OPTIONS: "-Dencryption.keystore.type=JCEKS');
    expect(yaml).toContain('-Dmetadata-keystore.aliases=metadata');
  });
});

describe('servicios tardios del stack final (schema-upgrade)', () => {
  it('en hops intermedios NO se arranca Share ni el indexer (el compose no los trae); en el final si', async () => {
    const { lateStackServicesFor } = await import('../src/domain/steps.js');
    const project = {
      project: 'g',
      target: { version: '26.2', edition: 'CE', search: { engine: 'elasticsearch' }, stack: { share: true } },
    } as unknown as ProjectConfig;
    expect(lateStackServicesFor({ project }, '7.4')).toEqual([]);
    expect(lateStackServicesFor({ project }, '25.3')).toEqual([]);
    expect(lateStackServicesFor({ project }, '26.2')).toEqual(['share', 'batch-indexer']);
  });
});

describe('permisos del content store', () => {
  it('asigna alf-data al uid de Alfresco con un contenedor efimero (sin sudo)', async () => {
    const { alfDataOwnershipCommand } = await import('../src/domain/steps.js');
    expect(alfDataOwnershipCommand('/srv/migracion')).toBe(
      'docker run --rm -v "/srv/migracion/alf-data:/d" alpine chown -R 33000 /d',
    );
  });
});

describe('guarda del restore: solo en el primer hop', () => {
  it('bloquea restaurar el dump del origen en un hop posterior (salto de version)', async () => {
    const { restoreHopViolation } = await import('../src/domain/steps.js');
    const project = { source: { version: '7.1.0' }, target: { version: '26.2' } } as unknown as ProjectConfig;
    expect(restoreHopViolation({ hop: '7.4', project })).toBeUndefined();
    expect(restoreHopViolation({ hop: '26.2', project })).toMatch(/solo en el PRIMER hop \(7\.4\)/);
    expect(restoreHopViolation({ hop: '25.3', project })).toBeDefined();
  });
});

describe('schema-upgrade: fallos de arranque con diagnostico', () => {
  it('detecta errores de arranque (no solo de esquema) y extrae la causa raiz', async () => {
    const { evaluateUpgradeLog, errorExcerpt } = await import('../src/domain/schema-upgrade.js');
    const log = [
      'INFO boot', 'ERROR [web.context.ContextLoader] [main] Context initialization failed',
      'org.springframework.beans.factory.BeanCreationException: Error creating bean dictionaryModelBootstrap',
      'Caused by: org.alfresco.service.cmr.dictionary.DictionaryException: 09260001 Could not import namespace acme',
      'SEVERE Context [/alfresco] startup failed due to previous errors',
    ].join('\n');
    expect(evaluateUpgradeLog('25.3', log).error).toBe('Context initialization failed');
    const excerpt = errorExcerpt(log)!;
    expect(excerpt).toContain('Context initialization failed');
    expect(excerpt).toContain('causa raiz:');
    expect(excerpt).toContain('Could not import namespace acme');
    expect(errorExcerpt('INFO todo bien')).toBeUndefined();
    // Log real de compose: prefijo de servicio y frames de pila fuera; la causa raiz primero.
    const composeLog = [
      'alfresco-1  | 2026 ERROR [web.context.ContextLoader] [main] Context initialization failed',
      "alfresco-1  | org.springframework.beans.factory.BeanCreationException: Could not import bootstrap model 'x/jsc.xml'",
      ...Array.from({ length: 80 }, (_, i) => `alfresco-1  | \tat org.springframework.Frame${i}(F.java:${i})`),
      'alfresco-1  | Caused by: org.alfresco.service.cmr.dictionary.DictionaryException: 08260002 Namespace http://x not found',
    ].join('\n');
    const e = errorExcerpt(composeLog)!;
    expect(e.startsWith('causa raiz: | Caused by: org.alfresco.service.cmr.dictionary.DictionaryException')).toBe(true);
    expect(e).not.toContain('Frame');
    expect(e).not.toContain('alfresco-1');
  });
});
