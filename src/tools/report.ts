/**
 * Tool del DOCUMENTO DE MIGRACION: genera el informe en markdown en el workspace desde el estado durable
 * (no toca origen ni destino). La salida pasa por la redaccion de secretos.
 */
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { workspaceCwd } from '../infra/session.js';
import { loadProject } from '../domain/project-config.js';
import { resolveUpgradePath } from '../domain/upgrade-paths.js';
import { loadCheckpoints } from '../domain/checkpoints.js';
import { loadHopProgress } from '../domain/hops.js';
import { loadJournal } from '../domain/journal.js';
import { loadExperiences, stateDir } from '../domain/experience.js';
import { applyEvidence, buildChecklist } from '../domain/checklist.js';
import { checklistFacts } from '../domain/evidence.js';
import { assessSource } from '../domain/assessment.js';
import { estimate } from '../domain/estimator.js';
import { renderMigrationReport } from '../domain/report.js';
import { windowHours } from './planning.js';
import { envSecrets, redactText } from '../security/redact.js';

const text = (value: string) => [{ type: 'text' as const, text: value }];

export function registerReportTools(ctx: Context): void {
  ctx.tools.register(
    defineTool({
      name: 'migrator_report',
      timeoutMs: 300_000,
      description:
        'Genera el DOCUMENTO DE MIGRACION (markdown) en el workspace desde el estado durable: resumen, entorno, ruta y hops, ejecucion por run con duraciones, tiempos estimado vs real (ventana de PROD), checklist con evidencia, decisiones/bloqueos, rollback y pendientes. Solo lectura del estado; no toca origen ni destino.',
      parameters: {
        file: { type: 'string', description: 'Nombre del fichero en el workspace (defecto INFORME-MIGRACION-<proyecto>-<stage>.md).' },
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => {
          const v = value as { file: string; lines: number; checklist: string };
          return text(`informe escrito en ${v.file} (${v.lines} lineas) · checklist ${v.checklist}`);
        },
      },
      async execute(args, exec) {
        const cwd = workspaceCwd(exec);
        const project = await loadProject(undefined, cwd);
        const state = stateDir();
        const hops = resolveUpgradePath(project.source.version, project.target.version);
        const checklist = applyEvidence(
          buildChecklist({
            project: project.project,
            sourceVersion: project.source.version,
            targetVersion: project.target.version,
            sourceEdition: project.source.edition ?? 'CE',
            targetEdition: project.target.edition ?? 'CE',
            sourceSearch: project.source.search?.engine ?? 'solr',
            targetSearch: project.target.search?.engine ?? 'solr',
            hops: hops.map((h) => ({ from: h.from, to: h.to, pathClass: h.pathClass })),
          }),
          await checklistFacts(state, project.project, hops),
        );
        // Estimacion con el inventario del origen si esta accesible; si no, el informe lo indica.
        const estimation = await assessSource(project, {
          restUser: process.env.MIGRATOR_SRC_USER,
          restPassword: process.env.MIGRATOR_SRC_PASSWORD,
        })
          .then((inv) =>
            inv.nodes > 0
              ? estimate({
                  contentBytes: inv.contentSizeBytes,
                  dbBytes: inv.dbSizeBytes,
                  nodes: inv.nodes,
                  auditCount: inv.audit,
                  hops: hops.length,
                  requiresValidationHops: hops.filter((h) => h.pathClass === 'REQUIRES_VALIDATION').length,
                  parallelism: 1,
                  changeRatePerDay: 0.01,
                  reindex: {
                    engine: project.target.search?.engine ?? 'solr',
                    edition: project.target.edition ?? 'CE',
                    targetVersion: project.target.version,
                    ...windowHours(undefined, project.raw),
                  },
                })
              : undefined,
          )
          .catch(() => undefined);
        const markdown = renderMigrationReport({
          project,
          hops,
          progress: await loadHopProgress(state, project.project),
          checkpoints: await loadCheckpoints(state, project.project),
          checklist,
          journal: await loadJournal(state, project.project),
          experience: (await loadExperiences(state, project.project)).find((r) => r.stage === project.stage),
          ...(estimation ? { estimate: estimation } : {}),
          generatedAt: new Date().toISOString(),
        });
        const file = path.resolve(cwd, args.file ?? `INFORME-MIGRACION-${project.project}-${project.stage}.md`);
        const safe = redactText(markdown, envSecrets());
        await writeFile(file, safe, 'utf8');
        const counts = ['OK', 'WARN', 'PENDING', 'FAIL'].map((s) => `${checklist.filter((i) => i.status === s).length} ${s}`).join(' · ');
        return { file, lines: safe.split('\n').length, checklist: counts };
      },
    }),
  );
}
