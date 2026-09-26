import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseDockerfile, roleOf, scanSourceStack } from '../src/domain/source-stack.js';

describe('inventario del stack del origen', () => {
  it('clasifica servicios por rol (shared-file-store es transform, no Share)', () => {
    expect(roleOf('shared-file-store', 'alfresco/alfresco-shared-file-store:0.16.0')).toBe('transform');
    expect(roleOf('share', 'alfresco/alfresco-share:7.1.0.1')).toBe('share');
    expect(roleOf('proxy', 'nginx:stable-alpine')).toBe('proxy');
    expect(roleOf('flowable-ui', 'eclipse-temurin:11')).toBe('other');
  });

  it('extrae FROM con ARG y los origenes de COPY/ADD', () => {
    const df = 'ARG ALFRESCO_TAG\nFROM alfresco/alfresco-content-repository-community:${ALFRESCO_TAG}\nCOPY modules/amps /x\nCOPY --chown=a:b config /y\nADD https://h/f.jar /z';
    expect(parseDockerfile(df, { ALFRESCO_TAG: '7.1.0' })).toEqual({ from: 'alfresco/alfresco-content-repository-community:7.1.0', sources: ['modules/amps', 'config'] });
  });

  it('detecta AMPs/JARs/config del repositorio construido y servicios estandar', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'stack-'));
    await mkdir(path.join(dir, 'alfresco/modules/amps'), { recursive: true });
    await mkdir(path.join(dir, 'alfresco/modules/jars'), { recursive: true });
    await writeFile(path.join(dir, 'alfresco/modules/amps/custom.amp'), 'x');
    await writeFile(path.join(dir, 'alfresco/modules/jars/lib.jar'), 'x');
    await writeFile(path.join(dir, 'alfresco/ldap.xml'), '<x/>');
    await writeFile(path.join(dir, 'alfresco/Dockerfile'), 'ARG T\nFROM alfresco/alfresco-content-repository-community:${T}\nCOPY modules/amps /a\nCOPY modules/jars /b\nCOPY ldap.xml /c\n');
    await writeFile(path.join(dir, '.env'), 'T=7.1.0\n');
    await writeFile(path.join(dir, 'docker-compose.yml'), 'services:\n  alfresco:\n    build:\n      context: ./alfresco\n      args:\n        T: ${T}\n  transform-core-aio:\n    image: alfresco/alfresco-transform-core-aio:2.5.3\n');
    const stack = await scanSourceStack(dir);
    expect(stack.services.map((s) => s.role)).toEqual(['repository', 'transform']);
    expect(stack.customizations.map((c) => c.kind).sort()).toEqual(['amp', 'config', 'jar']);
  });
});
