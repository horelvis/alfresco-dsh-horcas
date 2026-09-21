/**
 * Tools de EJECUCION (fase 2). El agente razona la composicion de pasos; estas tools la ejecutan.
 * Todas escriben SOLO en el destino (o leen el origen); requieren aprobacion (policy: ask).
 */
import type { Context } from '@deepseek-ai/cordis';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { workspaceCwd } from '../infra/session.js';
import { loadProject } from '../domain/project-config.js';
import { requireDistinctTarget } from '../domain/guards.js';
import { requireSupportedUpgradePath, upgradePathWarnings } from '../domain/upgrade-paths.js';
import { assertDestinationHop, recordCompletedHop } from '../domain/hops.js';
import { STEPS } from '../domain/steps.js';
import { runSteps } from '../domain/runner.js';
import { latestRunId, loadCheckpoints } from '../domain/checkpoints.js';
import { campaignId, loadExperiences, recordAttempt, resumePoint, stateDir, latestRehearsal, type AttemptOutcome, type ExperienceAttempt } from '../domain/experience.js';
import { gatherSourceFingerprint } from '../domain/fingerprint.js';
import { dataDir } from '../domain/data-dir.js';
import type { HostRef } from '../infra/exec.js';

const text = (value: string) => [{ type: 'text' as const, text: value }];

/** El arnes exige salida JSON *lossless*: elimina `undefined`/tipos no serializables (round-trip). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const lossless = (value: unknown): any => JSON.parse(JSON.stringify(value));

function destinationHost(project: Awaited<ReturnType<typeof loadProject>>, env = process.env): HostRef {
  if (project.access.mode === 'local' || Object.keys(project.access.hosts).length === 0) {
    return { name: 'local' };
  }
  const name = env.MIGRATOR_DST_HOST ?? 'dst-app';
  const host = project.access.hosts[name];
  if (!host) return { name: 'local' };
  return { name, host: host.host, user: host.user, keyFile: host.keyFile };
}

function newRunId(project: string): string {
  return `${project}-${Math.floor(Date.now() / 1000)}`;
}

export function registerExecutionTools(ctx: Context): void {
  ctx.tools.register(
    defineTool({
      name: 'migrator_steps_list',
      timeoutMs: 15_000,
      description: 'Lista los pasos de migracion disponibles (id, descripcion, si escriben en el destino).',
      parameters: {},
      output: {
        schema: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { id: { type: 'string' }, description: { type: 'string' }, writes: { type: 'boolean' } } } },
        render: (_args, value) =>
          text((value as Array<{ id: string; writes: boolean; description: string }>).map((s) => `- ${s.id}${s.writes ? ' [write]' : ''}: ${s.description}`).join('\n')),
      },
      async execute() {
        return STEPS.map((s) => ({ id: s.id, description: s.description, writes: s.writes }));
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'migrator_run_steps',
      description:
        'Ejecuta una composicion de pasos en el DESTINO (aprobacion requerida). En stage=prod exige ensayo validado. Soporta resume y dry-run.',
      parameters: {
        steps: { type: 'array', items: { type: 'string' }, required: true, description: 'Ids en orden, p.ej. [preflight-target, backup-source-db]' },
        execute: { type: 'boolean', description: 'false = dry-run (por defecto)' },
        resume: { type: 'boolean', description: 'omite pasos ya OK del run' },
        runId: { type: 'string', description: 'id de run para reanudar' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            runId: { type: 'string' },
            ok: { type: 'boolean' },
            resumeFrom: { type: 'string' },
            warnings: { type: 'array', items: { type: 'string' } },
            results: { type: 'array', items: { type: 'object', additionalProperties: true } },
          },
        },
        render: (_args, value) => {
          const v = value as { runId: string; ok: boolean; resumeFrom?: string; warnings?: string[]; results: Array<{ step: string; ok: boolean; skipped?: boolean; detail: string }> };
          const lines = v.results.map((r) => `${r.ok ? (r.skipped ? '~' : 'x') : '!'} ${r.step}: ${r.detail}`);
          const warns = (v.warnings ?? []).map((w) => `AVISO: ${w}`).join('\n');
          return text(`run=${v.runId} ok=${v.ok}${v.resumeFrom ? ` · reanudar en ${v.resumeFrom}` : ''}${warns ? `\n${warns}` : ''}\n${lines.join('\n')}`);
        },
      },
      async execute(args, exec) {
        const project = await loadProject(undefined, workspaceCwd(exec));
        const execute = args.execute === true;
        if (execute) requireDistinctTarget(project);
        const state = stateDir();
        const runId = args.runId ?? newRunId(project.project);
        const warnings: string[] = [];

        // Regla dura: nunca un salto de version no soportado; avisa de los saltos intermedios.
        const hops = requireSupportedUpgradePath(project.source.version, project.target.version);
        warnings.push(...upgradePathWarnings(hops));

        // Guarda de hops: en ruta multi-hop, el DESTINO debe estar en la version del hop que toca.
        if (execute) await assertDestinationHop(project, state, hops);

        // Experiencia previa de la campana (project+stage): primer intento o reanudacion pendiente.
        const previous = (await loadExperiences(state, project.project)).find(
          (r) => r.stage === project.stage,
        );
        if (!previous) {
          warnings.push(
            `Sin experiencia previa de "${project.project}" en stage=${project.stage}: primer intento` +
              (project.stage === 'prod' ? '' : '; se registrara al terminar para reutilizarla en PROD'),
          );
        } else {
          const pending = resumePoint(previous);
          if (pending && args.resume !== true) {
            warnings.push(
              `Hay un intento previo ${previous.attempts.at(-1)?.outcome} (fallo en ${pending}); ` +
                'considera resume=true para continuar sin repetir lo ya hecho',
            );
          }
        }

        if (execute && project.stage === 'prod') {
          const rehearsal = await latestRehearsal(state, project.project);
          if (!rehearsal || !rehearsal.validated) {
            throw new Error('PROD exige un ensayo validado (clone/TEST) antes de ejecutar');
          }
        }
        const report = await runSteps(
          {
            project,
            destination: destinationHost(project),
            source: { name: 'local' },
            state,
            runId,
            dryRun: !execute,
          },
          args.steps,
          { resume: args.resume === true, dryRun: !execute },
        );

        // Progreso de hops: si el run aplico el schema-upgrade y termino OK, registra el hop.
        if (execute && report.ok && args.steps.includes('schema-upgrade')) {
          await recordCompletedHop(state, project, hops);
        }

        // Registra el intento en la campana de experiencia (salvo dry-run) para poder restaurar y reanudar.
        if (execute && project.stage !== 'prod') {
          try {
            const fingerprint = await gatherSourceFingerprint(project.source.version, dataDir());
            const attempt: ExperienceAttempt = {
              id: runId,
              at: new Date().toISOString(),
              outcome: (report.ok ? 'ok' : 'failed') as AttemptOutcome,
              failedStep: report.failedStep,
              resumeFrom: report.resumeFrom,
              steps: report.results.map((r) => ({ id: r.step, ok: r.ok, durationMs: 0, detail: r.detail })),
              findings: [],
            };
            await recordAttempt(state, {
              project: project.project,
              stage: project.stage,
              sourceVersion: project.source.version,
              targetVersion: project.target.version,
              fingerprint,
              attempt,
            });
          } catch {
            // La experiencia no debe romper la ejecucion.
          }
        }
        return { runId: report.runId, ok: report.ok, resumeFrom: report.resumeFrom ?? '', warnings, results: lossless(report.results) };
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'migrator_run_status',
      timeoutMs: 15_000,
      description:
        'Devuelve el estado de los checkpoints de un run (que pasos estan hechos/fallidos) del proyecto del workspace. Si no se indica runId, usa el run mas reciente.',
      parameters: {
        runId: { type: 'string', description: 'id de run; por defecto, el mas reciente' },
      },
      output: {
        schema: { type: 'array', items: { type: 'object', additionalProperties: true } },
        render: (_args, value) =>
          text((value as Array<{ step: string; status: string; detail?: string }>).map((c) => `- ${c.step}: ${c.status}${c.detail ? ` (${c.detail})` : ''}`).join('\n') || '(sin checkpoints)'),
      },
      async execute(args, exec) {
        const config = await loadProject(undefined, workspaceCwd(exec));
        const runId = args.runId ?? (await latestRunId(stateDir(), config.project));
        if (!runId) return [];
        const checkpoints = await loadCheckpoints(stateDir(), config.project, runId);
        const latest = new Map<string, (typeof checkpoints)[number]>();
        for (const c of checkpoints) latest.set(c.step, c);
        return lossless([...latest.values()].map((c) => ({ ...c })));
      },
    }),
  );
}
