import { describe, expect, it } from 'vitest';
import { estimate } from '../src/domain/estimator.js';
import { recommendStrategy } from '../src/domain/strategy.js';
import { buildChecklist, gatesText, renderChecklistMarkdown } from '../src/domain/checklist.js';
import { escapeCsv, epic, issue, toCsv } from '../src/domain/jira.js';

describe('estimator', () => {
  const base = {
    contentBytes: 200 * 1_000_000_000,
    dbBytes: 60 * 1_000_000_000,
    nodes: 5_000_000,
    auditCount: 0,
    hops: 3,
    requiresValidationHops: 1,
    parallelism: 4,
    changeRatePerDay: 0.01,
  };

  it('calcula fases, cuello y confianza LOW sin overrides', () => {
    const result = estimate(base);
    expect(result.phases.map((p) => p.phase)).toEqual(['ASSESSMENT', 'PRE_STAGING', 'CUTOVER', 'POST_CUTOVER']);
    expect(result.cutoverMinutes).toBeGreaterThan(0);
    expect(result.confidence).toBe('LOW');
    expect(['SCHEMA_UPGRADE', 'REINDEX', 'CONTENT_COPY']).toContain(result.bottleneck);
    expect(result.risks.join(' ')).toContain('REQUIRES_VALIDATION');
  });

  it('sube a HIGH con overrides medidos', () => {
    expect(estimate({ ...base, throughputOverrides: { contentCopyMbps: 500 } }).confidence).toBe('HIGH');
  });
});

describe('strategy', () => {
  it('repos pequeno -> export/import o API', () => {
    const result = recommendStrategy({ fileCount: 1000, sizeBytes: 1_000_000_000, nodes: 2000, storageAccess: false, transformRequired: false });
    expect(result.content).toBe('C5_EXPORT_IMPORT');
    expect(result.db).toBe('D2_DUMP_RESTORE');
    expect(result.index).toBe('I2_STANDARD');
  });

  it('volumen alto sin acceso a storage -> bulk delta y descarta API', () => {
    const result = recommendStrategy({ fileCount: 2_000_000, sizeBytes: 500_000_000_000, nodes: 3_000_000, storageAccess: false, transformRequired: false });
    expect(result.content).toBe('C2_BULK_DELTA');
    expect(result.discarded.join(' ')).toContain('C4');
  });

  it('muchos nodos -> reindex por lotes de ID', () => {
    expect(recommendStrategy({ fileCount: 500_000, sizeBytes: 300_000_000_000, nodes: 2_000_000, storageAccess: true, transformRequired: false }).index).toBe('I1_FULL_BY_ID');
  });
});

describe('checklist', () => {
  const input = {
    project: 'demo',
    sourceVersion: '7.1.0',
    targetVersion: '26.2',
    sourceEdition: 'CE',
    targetEdition: 'EE',
    sourceSearch: 'solr',
    targetSearch: 'opensearch',
    hops: [{ from: '7.1.0', to: '7.4', pathClass: 'REQUIRES_VALIDATION' }],
  };

  it('26 EE incluye Solr-off y gates; ruta con validacion es WARN', () => {
    const items = buildChecklist(input);
    const all = items.map((i) => i.text).join('\n');
    expect(all).toContain('Solr desmantelado');
    expect(gatesText(input)).toContain('Java 21');
    expect(items.find((i) => i.text.startsWith('Ruta de upgrade'))?.status).toBe('WARN');
  });

  it('render markdown con secciones', () => {
    const md = renderChecklistMarkdown('demo', buildChecklist(input));
    expect(md).toContain('## Pre-cutover');
    expect(md).toContain('## Post-cutover');
  });

  it('23 CE no pide Solr-off', () => {
    const items = buildChecklist({ ...input, targetVersion: '23.4', targetEdition: 'CE' });
    expect(items.map((i) => i.text).join('\n')).not.toContain('Solr desmantelado');
  });
});

describe('jira csv', () => {
  it('escapa segun RFC 4180', () => {
    expect(escapeCsv('a,b')).toBe('"a,b"');
    expect(escapeCsv('dice "hola"')).toBe('"dice ""hola"""');
    expect(escapeCsv('simple')).toBe('simple');
  });

  it('genera cabecera + filas', () => {
    const csv = toCsv([epic('E1', 'migracion', 'desc'), issue('T1', 'Task', 'High', 'migracion', 'nota', 'E1')]);
    const lines = csv.trim().split('\n');
    expect(lines[0]).toBe('Summary,Issue Type,Epic Name,Priority,Labels,Description,Epic Link');
    expect(lines).toHaveLength(3);
  });
});
