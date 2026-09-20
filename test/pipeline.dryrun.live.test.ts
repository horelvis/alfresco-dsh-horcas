/**
 * Dry-run del pipeline completo (live, sin escrituras).
 *
 * Genera el Compose de cada hop (sin levantar nada) y compone el pipeline de pasos con dryRun=true:
 * ningun paso de escritura debe ejecutar comando. Garantiza el dry-run a nivel de dominio, sin depender
 * de la aprobacion por nombre de tool del arnes.
 *
 * Requiere `MIGRATOR_LIVE_PIPELINE=true` para no ejecutarse por accidente.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadProject } from '../src/domain/project-config.js';
import { resolveUpgradePath } from '../src/domain/upgrade-paths.js';
import { projectToComposeRequest, writeCompose } from '../src/domain/provision.js';
import { runSteps } from '../src/domain/runner.js';
import { STEPS } from '../src/domain/steps.js';
import type { HostRef } from '../src/infra/exec.js';

const projectPath = process.env.MIGRATOR_LIVE_PROJECT ?? 'data/projects/example.yaml';
const enabled = process.env.MIGRATOR_LIVE_PIPELINE === 'true';

const WRITE_STEPS = ['backup-source-db', 'copy-content', 'restore-target-db', 'schema-upgrade', 'reindex'];

function destinationHost(project: Awaited<ReturnType<typeof loadProject>>): HostRef {
  if (project.access.mode === 'local' || Object.keys(project.access.hosts).length === 0) return { name: 'local' };
  const name = process.env.MIGRATOR_DST_HOST ?? 'dst-app';
  const host = project.access.hosts[name];
  return host ? { name, host: host.host, user: host.user, keyFile: host.keyFile } : { name: 'local' };
}

describe.runIf(enabled)('pipeline dry-run (live)', () => {
  it('genera el compose de cada hop sin levantar nada', async () => {
    const project = await loadProject(projectPath);
    const hops = resolveUpgradePath(project.source.version, project.target.version);
    expect(hops.length).toBeGreaterThan(0);
    const dir = mkdtempSync(path.join(tmpdir(), 'migrator-dryrun-compose-'));
    const files: string[] = [];
    for (const hop of hops) {
      files.push(await writeCompose(projectToComposeRequest(project, hop.to), dir));
    }
    expect(files).toHaveLength(hops.length);
  }, 30_000);

  it('compone el pipeline completo en dry-run: ningun paso de escritura ejecuta', async () => {
    const project = await loadProject(projectPath);
    const state = mkdtempSync(path.join(tmpdir(), 'migrator-dryrun-state-'));
    const report = await runSteps(
      { project, destination: destinationHost(project), state, runId: 'dryrun', dryRun: true },
      STEPS.map((s) => s.id),
      { dryRun: true },
    );
    const steps = report.results.map((r) => r.step);
    expect(steps).toEqual(expect.arrayContaining(WRITE_STEPS));
    for (const result of report.results) {
      if (WRITE_STEPS.includes(result.step)) {
        expect(result.ok, `${result.step}: ${result.detail}`).toBe(true);
        expect(result.skipped, result.step).toBe(true);
      }
    }
  }, 60_000);
});
