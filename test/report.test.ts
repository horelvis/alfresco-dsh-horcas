import { describe, expect, it } from 'vitest';
import { measuredPhaseMinutes, renderMigrationReport, type ReportData } from '../src/domain/report.js';
import { buildChecklist } from '../src/domain/checklist.js';
import { requireSupportedUpgradePath } from '../src/domain/upgrade-paths.js';
import type { Checkpoint } from '../src/domain/checkpoints.js';
import type { ProjectConfig } from '../src/domain/project-config.js';

const cp = (runId: string, step: string, status: Checkpoint['status'], durationMs: number, detail = ''): Checkpoint =>
  ({ runId, project: 'g', step, status, at: '2026-09-26T09:30:00Z', attempt: 1, detail, durationMs });

const checkpoints = [
  cp('dry', 'provision-hop', 'SKIPPED', 0, 'dry-run: hop 7.4'),
  cp('r1', 'backup-source-db', 'OK', 60_000),
  cp('r1', 'copy-content', 'OK', 120_000),
  cp('r1', 'schema-upgrade', 'OK', 300_000),
  cp('r1', 'smoke-boot', 'OK', 1_000, 'hop 26.2 · version=26.2.0 · root http=200'),
  cp('r1', 'reindex', 'FAILED', 80, 'BLOQUEO (decision humana): sin mecanismo'),
];

describe('documento de migracion', () => {
  it('suma los tiempos reales por fase (solo OK, sin dry-run)', () => {
    const m = measuredPhaseMinutes(checkpoints);
    expect(m.PRE_STAGING).toBe(3);
    expect(m.CUTOVER).toBeCloseTo(5 + 1 / 60);
    expect(m.POST_CUTOVER).toBe(0);
  });

  it('renderiza secciones, runs reales, checklist y pendientes', () => {
    const hops = requireSupportedUpgradePath('7.1.0', '26.2');
    const data: ReportData = {
      project: {
        project: 'g', stage: 'test',
        source: { version: '7.1.0', edition: 'CE', database: { engine: 'postgresql', name: 'alfresco' }, contentStore: { path: '/src/cs' }, search: { engine: 'solr' } },
        target: { version: '26.2', edition: 'CE', deployment: 'compose', dataDir: '/d', search: { engine: 'elasticsearch' } },
        migration: { contentStrategy: 'C2', dbStrategy: 'D2', indexStrategy: 'I2', coherencePolicy: 'WARN' },
      } as unknown as ProjectConfig,
      hops,
      progress: hops.map((h) => ({ project: 'g', from: h.from, to: h.to, at: '2026-09-26T09:34:00Z' })),
      checkpoints,
      checklist: buildChecklist({ project: 'g', sourceVersion: '7.1.0', targetVersion: '26.2', sourceEdition: 'CE', targetEdition: 'CE', sourceSearch: 'solr', targetSearch: 'elasticsearch', hops: hops.map((h) => ({ from: h.from, to: h.to, pathClass: h.pathClass })) }),
      journal: [{ at: '2026-09-26T09:40:00Z', project: 'g', kind: 'blocker', summary: 'reindex CE 26.2 sin mecanismo' }],
      generatedAt: '2026-09-26T10:00:00Z',
    };
    const md = renderMigrationReport(data);
    for (const heading of ['# Informe de migracion — g', '## 1. Resumen ejecutivo', '## 4. Ejecucion', '## 5. Tiempos', '## 6. Verificacion', '## 8. Rollback', '## 9. Pendiente']) {
      expect(md).toContain(heading);
    }
    expect(md).toContain('ruta completada');
    expect(md).toContain('Run `r1`');
    expect(md).not.toContain('Run `dry`');
    expect(md).toContain('| 7.4 → 25.3 |');
    expect(md).toContain('reindex CE 26.2 sin mecanismo');
  });
});
