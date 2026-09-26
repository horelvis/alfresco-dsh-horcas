import { describe, expect, it } from 'vitest';
import { reindexPlan, searchFamily } from '../src/domain/reindex-policy.js';
import { estimate } from '../src/domain/estimator.js';

const base = { metadataNodesPerSec: 400, contentPassFactor: 4, engine: 'elasticsearch', edition: 'EE', targetVersion: '26.2' };

describe('politica de reindex segun tamaño y ventana', () => {
  it('familia de busqueda por motor/edicion/version', () => {
    expect(searchFamily('elasticsearch', 'CE', '26.2')).toBe('SEARCH_COMMUNITY');
    expect(searchFamily('elasticsearch', 'CE', '25.3')).toBe('SOLR');
    expect(searchFamily('elasticsearch', 'EE', '25.3')).toBe('SEARCH_ENTERPRISE');
    expect(searchFamily('solr', 'CE', '26.2')).toBe('SOLR');
  });

  it('repo pequeño: online tras el corte', () => {
    expect(reindexPlan({ ...base, nodes: 5760, windowHours: 8 }).policy).toBe('POST_CUTOVER_ONLINE');
  });

  it('millones de nodos: metadatos primero si caben; si no, pre-indexado + delta', () => {
    // 10M nodos a 400/s = ~6.9 h de metadatos, ~27.8 h de contenido
    expect(reindexPlan({ ...base, nodes: 10_000_000, windowHours: 8 }).policy).toBe('METADATA_FIRST');
    expect(reindexPlan({ ...base, nodes: 10_000_000, windowHours: 4 }).policy).toBe('PRE_INDEX_DELTA');
  });

  it('Search Community (CE 26.2) no separa metadatos: pre-indexado con watermark sembrado', () => {
    const plan = reindexPlan({ ...base, edition: 'CE', nodes: 10_000_000, windowHours: 8 });
    expect(plan.policy).toBe('PRE_INDEX_DELTA');
    expect(plan.steps.join(' ')).toContain('watermark');
  });

  it('el estimador devuelve la politica y avisa si no cabe en la ventana', () => {
    const e = estimate({ contentBytes: 1e12, dbBytes: 5e10, nodes: 10_000_000, auditCount: 0, hops: 3, requiresValidationHops: 0, parallelism: 4, changeRatePerDay: 0.01,
      reindex: { engine: 'elasticsearch', edition: 'EE', targetVersion: '26.2', windowHours: 4 } });
    expect(e.reindexPlan?.policy).toBe('PRE_INDEX_DELTA');
    expect(e.risks.join(' ')).toContain('no cabe en la ventana');
  });
});
