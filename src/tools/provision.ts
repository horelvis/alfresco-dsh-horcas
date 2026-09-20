/**
 * Tool de PROVISION del destino: genera el compose por hop y (con execute) levanta el stack.
 * Respeta MIGRATOR_DST_PROVISION (auto|managed|external) y el auto-skip si ya esta desplegado.
 */
import type { Context } from '@deepseek-ai/cordis';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { loadProject } from '../domain/project-config.js';
import { requireDistinctTarget } from '../domain/guards.js';
import { requireSupportedUpgradePath } from '../domain/upgrade-paths.js';
import {
  destinationRunning,
  projectToComposeRequest,
  provisionCompose,
  shouldSkipProvision,
  writeCompose,
} from '../domain/provision.js';
import { stateDir } from '../domain/experience.js';
import { computeAlfrescoMemory, type AlfrescoMemory } from '../domain/memory.js';
import { runShell, type HostRef } from '../infra/exec.js';

const text = (value: string) => [{ type: 'text' as const, text: value }];
const json = <T>(value: T): never => JSON.parse(JSON.stringify(value)) as never;

/** RAM asignada a Docker en el host (bytes); `undefined` si no se puede detectar. */
async function dockerMemTotal(host: HostRef): Promise<number | undefined> {
  try {
    const result = await runShell(host, `docker info --format '{{.MemTotal}}'`);
    const bytes = Number.parseInt(result.stdout.trim(), 10);
    return result.exitCode === 0 && Number.isFinite(bytes) && bytes > 0 ? bytes : undefined;
  } catch {
    return undefined;
  }
}

function destinationHost(project: Awaited<ReturnType<typeof loadProject>>): HostRef {
  if (project.access.mode === 'local' || Object.keys(project.access.hosts).length === 0) return { name: 'local' };
  const name = process.env.MIGRATOR_DST_HOST ?? 'dst-app';
  const host = project.access.hosts[name];
  return host ? { name, host: host.host, user: host.user, keyFile: host.keyFile } : { name: 'local' };
}

export function registerProvisionTools(ctx: Context): void {
  ctx.tools.register(
    defineTool({
      name: 'migrator_provision',
      description:
        'Provisiona el DESTINO en Docker Compose por hop (genera docker-compose-<hop>.yml y levanta el stack). Auto-skip con MIGRATOR_DST_PROVISION=auto|managed|external.',
      parameters: {
        project: { type: 'string', required: true },
        execute: { type: 'boolean', description: 'false = solo generar los compose (por defecto)' },
        withShare: { type: 'boolean', description: 'incluir Share en el compose' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: {
            mode: { type: 'string' },
            skipped: { type: 'boolean' },
            hops: { type: 'number' },
            files: { type: 'array', items: { type: 'string' } },
            executed: { type: 'boolean' },
          },
        },
        render: (_args, value) => {
          const v = value as { mode: string; skipped: boolean; files: string[]; executed: boolean };
          return text(
            `modo=${v.mode} omitido=${v.skipped} ejecutado=${v.executed}\n${v.files.map((f) => `- ${f}`).join('\n')}`,
          );
        },
      },
      async execute(args) {
        const project = await loadProject(args.project);
        const mode = process.env.MIGRATOR_DST_PROVISION ?? 'auto';
        const host = destinationHost(project);
        const execute = args.execute === true;
        if (execute) requireDistinctTarget(project);
        const running = execute && (await destinationRunning(host));
        if (execute && shouldSkipProvision(mode, running)) {
          return json({ mode, skipped: true, hops: 0, files: [], executed: false });
        }
        const hops = requireSupportedUpgradePath(project.source.version, project.target.version);
        const workDir = `${stateDir()}/provision`;
        const files: string[] = [];
        const memTotal = await dockerMemTotal(host);
        const memory: AlfrescoMemory | undefined = memTotal ? computeAlfrescoMemory(memTotal) : undefined;
        for (const hop of hops) {
          const request = projectToComposeRequest(project, hop.to, args.withShare === true, memory);
          if (execute) {
            const result = await provisionCompose(request, workDir, host);
            files.push(result.file);
          } else {
            files.push(await writeCompose(request, workDir));
          }
        }
        return json({ mode, skipped: false, hops: files.length, files, executed: execute });
      },
    }),
  );
}
