/**
 * Tools de EJECUCION (fase 2). El agente razona la composicion de pasos; estas tools la ejecutan.
 * Todas escriben SOLO en el destino (o leen el origen); requieren aprobacion (policy: ask).
 */
import type { Context } from '@deepseek-ai/cordis';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { loadProject } from '../domain/project-config.js';
import { STEPS } from '../domain/steps.js';
import { runSteps } from '../domain/runner.js';
import { loadCheckpoints } from '../domain/checkpoints.js';
import { stateDir, latestRehearsal } from '../domain/experience.js';
import type { HostRef } from '../infra/exec.js';

const text = (value: string) => [{ type: 'text' as const, text: value }];

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
        project: { type: 'string', required: true },
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
            results: { type: 'array', items: { type: 'object', additionalProperties: true } },
          },
        },
        render: (_args, value) => {
          const v = value as { runId: string; ok: boolean; results: Array<{ step: string; ok: boolean; skipped?: boolean; detail: string }> };
          const lines = v.results.map((r) => `${r.ok ? (r.skipped ? '~' : 'x') : '!'} ${r.step}: ${r.detail}`);
          return text(`run=${v.runId} ok=${v.ok}\n${lines.join('\n')}`);
        },
      },
      async execute(args) {
        const project = await loadProject(args.project);
        const execute = args.execute === true;
        const state = stateDir();
        const runId = args.runId ?? newRunId(project.project);
        if (execute && project.stage === 'prod') {
          const rehearsal = await latestRehearsal(state, project.project);
          if (!rehearsal || !rehearsal.validated) {
            throw new Error('PROD exige un ensayo validado (clone/TEST) antes de ejecutar');
          }
        }
        const report = await runSteps(
          { project, destination: destinationHost(project), state, runId, dryRun: !execute },
          args.steps,
          { resume: args.resume === true, dryRun: !execute },
        );
        return { runId: report.runId, ok: report.ok, results: report.results.map((r) => ({ ...r })) };
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'migrator_run_status',
      description: 'Devuelve el estado de los checkpoints de un run (que pasos estan hechos/fallidos).',
      parameters: {
        project: { type: 'string', required: true },
        runId: { type: 'string', required: true },
      },
      output: {
        schema: { type: 'array', items: { type: 'object', additionalProperties: true } },
        render: (_args, value) =>
          text((value as Array<{ step: string; status: string; detail?: string }>).map((c) => `- ${c.step}: ${c.status}${c.detail ? ` (${c.detail})` : ''}`).join('\n') || '(sin checkpoints)'),
      },
      async execute(args) {
        const checkpoints = await loadCheckpoints(stateDir(), args.project, args.runId);
        const latest = new Map<string, (typeof checkpoints)[number]>();
        for (const c of checkpoints) latest.set(c.step, c);
        return [...latest.values()].map((c) => ({ ...c }));
      },
    }),
  );
}
