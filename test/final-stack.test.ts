import { describe, expect, it } from 'vitest';
import yamlLib from 'js-yaml';
import { renderCompose, renderStackEnv, composeImages, projectToComposeRequest } from '../src/domain/provision.js';
import { proxyConfig, repositoryJavaOpts, shareImage } from '../src/domain/final-stack.js';
import type { ProjectConfig } from '../src/domain/project-config.js';

const stack = { share: true, transform: true, proxy: true, publicHost: '192.0.2.10', extensions: { repo: '/d/ext/repo' } };
const request = { projectName: 'acme-710', acsVersion: '26.2', edition: 'CE', deployment: 'compose', database: { engine: 'postgresql' }, search: { engine: 'ELASTICSEARCH' }, dataDir: '/d', stack };

describe('stack de la version final', () => {
  it('imagenes del compose oficial y credenciales del broker en 26.x', () => {
    expect(shareImage({}, '26.2', 'CE')).toBe('alfresco/alfresco-share:26.2.2');
    expect(repositoryJavaOpts(undefined, '26.2').join(' ')).toContain('-Dmessaging.broker.username=${ACTIVEMQ_ADMIN_LOGIN}');
    // La URL del broker va CITADA dentro de JAVA_OPTS (catalina.sh la evalua con `eval`).
    expect(repositoryJavaOpts(undefined, '26.2').join(' ')).toContain(
      '-Dmessaging.broker.url="failover:(nio://activemq:61616)?timeout=3000"',
    );
    expect(repositoryJavaOpts(undefined, '25.3')).toEqual([]);
    expect(composeImages(request)).toEqual([
      'postgres:15', 'alfresco/alfresco-activemq:6.2.9-jre17-rockylinux8', 'docker.elastic.co/elasticsearch/elasticsearch:8.17.0',
      'alfresco/alfresco-share:26.2.2', 'alfresco/alfresco-transform-core-aio:5.4.4', 'alfresco/alfresco-elasticsearch-batch-indexing:5.7.1',
      'nginx:stable-alpine', 'alfresco/alfresco-content-repository-community:26.2.0',
    ]);
  });

  it('compose: proxy publica 8080, Share tras el proxy, imagen derivada con extensiones', () => {
    const yaml = renderCompose(request);
    expect(yaml).toContain('  proxy:\n    image: nginx:stable-alpine\n    ports:\n      - "8080:8080"');
    expect(yaml).toContain('image: acme-710-repo-ext:26.2');
    expect(yaml).toContain('dockerfile_inline: |');
    expect(yaml).toContain('FROM alfresco/alfresco-content-repository-community:26.2.0');
    expect(yaml).toContain('CSRF_FILTER_REFERER: http://192.0.2.10:8080/share/.*');
    expect(yaml).toContain('-DlocalTransform.core-aio.url=http://transform-core-aio:8090/');
    // JAVA_OPTS sale como escalar YAML con las comillas internas ESCAPADAS y parses valido; el valor
    // resultante conserva la URL CITADA (lo que catalina.sh necesita para no romper en `eval`).
    expect(yaml).toContain('-Dmessaging.broker.url=\\"failover:(nio://activemq:61616)?timeout=3000\\"');
    const doc = yamlLib.load(yaml) as { services: { alfresco: { environment: { JAVA_OPTS: string } } } };
    expect(doc.services.alfresco.environment.JAVA_OPTS).toContain(
      '-Dmessaging.broker.url="failover:(nio://activemq:61616)?timeout=3000"',
    );
    expect(yaml.match(/"8080:8080"/g)?.length).toBe(1);
  });

  it('el stack solo se aplica en el hop final', () => {
    const project = { project: 'g', target: { version: '26.2', stack } } as unknown as ProjectConfig;
    expect(projectToComposeRequest(project, '25.3', false).stack).toBeUndefined();
    expect(projectToComposeRequest(project, '26.2', false).stack).toEqual(stack);
  });

  it('proxy: resolucion diferida y bloqueo de la API de Solr', () => {
    const conf = proxyConfig(true);
    expect(conf).toContain('resolver 127.0.0.11');
    expect(conf).toContain('location /share/ { proxy_pass $share;');
    expect(conf).toContain('api/solr/ { return 403; }');
  });

  it('renderStackEnv deja las claves del compose en el .env del stack (sin entorno, sin vacios)', () => {
    const env = renderStackEnv({ POSTGRES_PASSWORD: 'p', ACTIVEMQ_ADMIN_LOGIN: 'admin', ACTIVEMQ_ADMIN_PASSWORD: 'a' });
    expect(env).toBe('POSTGRES_PASSWORD=p\nACTIVEMQ_ADMIN_LOGIN=admin\nACTIVEMQ_ADMIN_PASSWORD=a\n');
  });
});

describe('validacion con docker (si esta disponible)', () => {
  it('docker compose config acepta el compose del stack final', async () => {
    const { runShell, runShellWithInput } = await import('../src/infra/exec.js');
    if ((await runShell({ name: 'local' }, 'docker compose version')).exitCode !== 0) return;
    const env = "POSTGRES_PASSWORD=x ACTIVEMQ_ADMIN_LOGIN=admin ACTIVEMQ_ADMIN_PASSWORD=y SEARCH_SHARED_SECRET=z";
    const result = await runShellWithInput({ name: 'local' }, `${env} docker compose -f - config -q`, renderCompose(request));
    expect(result.stderr.trim()).toBe('');
    expect(result.exitCode).toBe(0);
  });
});

describe('stack por version (target.stackByVersion)', () => {
  it('stackForVersion: por version manda; si no, stack general solo en la final; si no, nada', async () => {
    const { stackForVersion } = await import('../src/domain/final-stack.js');
    const general = { share: true, transform: true };
    const target = { version: '26.2', stack: general, stackByVersion: { '25.3': { share: true }, '7.4.2': {} } };
    expect(stackForVersion(target, '25.3')).toEqual({ share: true });
    expect(stackForVersion(target, '7.4')).toEqual({}); // clave con parche: se compara mayor.menor
    expect(stackForVersion(target, '26.2')).toEqual(general);
    expect(stackForVersion({ version: '26.2', stack: general }, '25.3')).toBeUndefined();
    // Por version tambien puede anular el general en la final.
    expect(stackForVersion({ version: '26.2', stack: general, stackByVersion: { '26.2': { share: false } } }, '26.2')).toEqual({ share: false });
  });

  it('el compose del hop y los servicios tardios usan el stack de SU version', async () => {
    const { lateStackServicesFor } = await import('../src/domain/steps.js');
    const project = {
      project: 'g',
      target: { version: '26.2', edition: 'CE', search: { engine: 'elasticsearch' }, stack: { share: true }, stackByVersion: { '25.3': { share: true } } },
    } as unknown as ProjectConfig;
    expect(projectToComposeRequest(project, '25.3', false).stack).toEqual({ share: true });
    expect(projectToComposeRequest(project, '7.4', false).stack).toBeUndefined();
    expect(lateStackServicesFor({ project }, '25.3')).toEqual(['share']); // sin indexer: 25.3 no es Search Community
    expect(lateStackServicesFor({ project }, '7.4')).toEqual([]);
    expect(lateStackServicesFor({ project }, '26.2')).toEqual(['share', 'batch-indexer']);
  });

  it('el schema acepta stackByVersion y rechaza claves que no son version', async () => {
    const { validateProject } = await import('../src/domain/wizard.js');
    const base = {
      project: 'gadex-test', access: { mode: 'local' },
      source: { baseUrl: 'http://s/alfresco', version: '7.1.0', database: { engine: 'postgresql' }, contentStore: { type: 'FS', path: '/x' } },
      target: { version: '26.2', database: { engine: 'postgresql' }, contentStore: { type: 'FS', path: '/y' }, search: { engine: 'elasticsearch' } },
    };
    expect(await validateProject({ ...base, target: { ...base.target, stackByVersion: { '25.3': { share: false }, '26.2': { share: true } } } })).toEqual([]);
    expect((await validateProject({ ...base, target: { ...base.target, stackByVersion: { final: { share: true } } } })).length).toBeGreaterThan(0);
  });
});
