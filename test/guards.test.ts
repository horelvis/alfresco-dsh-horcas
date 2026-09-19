import { describe, expect, it } from 'vitest';
import { assessDistinctTarget, sameContentStore, sameDatabase } from '../src/domain/guards.js';
import type { ProjectConfig } from '../src/domain/project-config.js';

function project(over: Partial<ProjectConfig> = {}): ProjectConfig {
  const base: ProjectConfig = {
    project: 'demo',
    stage: 'test',
    access: { mode: 'local', hosts: {} },
    source: {
      version: '7.1.0',
      database: { engine: 'postgresql', host: 'localhost', port: 5432, name: 'alfresco', user: 'alfresco' },
      contentStore: { type: 'FS', path: '/data/contentstore' },
    },
    target: {
      version: '26.2',
      database: { engine: 'postgresql', host: 'dst', port: 5432, name: 'alfresco' },
      contentStore: { type: 'FS', path: '/alf_data-26/contentstore' },
    },
    migration: {},
    raw: {},
  };
  return { ...base, ...over } as ProjectConfig;
}

describe('sameDatabase', () => {
  it('misma host/port/name -> true', () => {
    expect(sameDatabase({ host: 'h', port: 5432, name: 'alfresco' }, { host: 'h', port: 5432, name: 'alfresco' })).toBe(true);
  });
  it('distinto host o nombre -> false', () => {
    expect(sameDatabase({ host: 'h', port: 5432, name: 'alfresco' }, { host: 'x', port: 5432, name: 'alfresco' })).toBe(false);
    expect(sameDatabase({ host: 'h', port: 5432, name: 'a' }, { host: 'h', port: 5432, name: 'b' })).toBe(false);
  });
  it('sin datos -> false', () => {
    expect(sameDatabase(undefined, { host: 'h', port: 1, name: 'a' })).toBe(false);
  });
});

describe('sameContentStore', () => {
  it('mismo path FS (normalizando barra final) -> true', () => {
    expect(sameContentStore({ type: 'FS', path: '/data/store' }, { type: 'FS', path: '/data/store/' })).toBe(true);
  });
  it('paths distintos -> false', () => {
    expect(sameContentStore({ type: 'FS', path: '/a' }, { type: 'FS', path: '/b' })).toBe(false);
  });
  it('mismo bucket objeto -> true; tipos distintos -> false', () => {
    expect(sameContentStore({ type: 'S3', bucket: 'b' } as never, { type: 'S3', bucket: 'b' } as never)).toBe(true);
    expect(sameContentStore({ type: 'S3', bucket: 'b' } as never, { type: 'AZURE', bucket: 'b' } as never)).toBe(false);
  });
});

describe('assessDistinctTarget / requireDistinctTarget', () => {
  it('destino distinto -> no bloquea', () => {
    expect(assessDistinctTarget(project()).blocked).toBe(false);
  });

  it('misma BD -> BLOCKER', () => {
    const p = project();
    p.target.database = { engine: 'postgresql', host: 'localhost', port: 5432, name: 'alfresco' };
    const result = assessDistinctTarget(p);
    expect(result.blocked).toBe(true);
    expect(result.findings[0]?.risk).toBe('SAME_DATABASE');
  });

  it('mismo content store -> BLOCKER', () => {
    const p = project();
    p.target.contentStore = { type: 'FS', path: '/data/contentstore' };
    const result = assessDistinctTarget(p);
    expect(result.blocked).toBe(true);
    expect(result.findings[0]?.risk).toBe('SAME_CONTENT_STORE');
  });
});
