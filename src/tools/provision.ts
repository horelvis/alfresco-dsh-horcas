/**
 * Tool de PROVISION del destino: genera el compose por hop y (con execute) levanta el stack.
 * Respeta MIGRATOR_DST_PROVISION (auto|managed|external) y el auto-skip si ya esta desplegado.
 */
import type { Context } from '@deepseek-ai/cordis';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { workspaceCwd } from '../infra/session.js';
import { loadProject } from '../domain/project-config.js';
import { requireDistinctTarget } from '../domain/guards.js';
import { requireSupportedUpgradePath } from '../domain/upgrade-paths.js';
import {
  destinationRunning,
  projectToComposeRequest,
  provisionCompose,
  ensureDataDirs,
  shouldSkipProvision,
  stopRunningStacks,
  validateCompose,
  writeCompose,
  renderCompose,
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
        'Provisiona el DESTINO en Docker Compose por hop: para los stacks que ya corren (p. ej. un 26.2 que no toca) y levanta docker-compose-<hop>.yml. Auto-skip con MIGRATOR_DST_PROVISION=auto|managed|external; el proyecto a parar se fija con MIGRATOR_DST_COMPOSE_PROJECT.',
      parameters: {
        execute: { type: 'boolean', description: 'false = solo generar los compose (por defecto)' },
        withShare: { type: 'boolean', description: 'incluir Share en el compose' },
        dstDir: {
          type: 'string',
          description:
            'Carpeta base EN EL HOST DESTINO (por SSH, p.ej. 192.168.100.51) para los datos de la version: content store en <dstDir>/alf-data y BD en <dstDir>/pg-data. NO es una ruta local. Si falta, se usa MIGRATOR_DST_DIR.',
        },
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
            stopped: { type: 'array', items: { type: 'string' } },
            executed: { type: 'boolean' },
          },
        },
        render: (_args, value) => {
          const v = value as { mode: string; skipped: boolean; files: string[]; stopped?: string[]; executed: boolean };
          const stopped = v.stopped && v.stopped.length > 0 ? `\nparados: ${v.stopped.join(', ')}` : '';
          return text(
            `modo=${v.mode} omitido=${v.skipped} ejecutado=${v.executed}${stopped}\n${v.files.map((f) => `- ${f}`).join('\n')}`,
          );
        },
      },
      async execute(args, exec) {
        const project = await loadProject(undefined, workspaceCwd(exec));
        const mode = process.env.MIGRATOR_DST_PROVISION ?? 'auto';
        const host = destinationHost(project);
        const execute = args.execute === true;
        if (execute) requireDistinctTarget(project);
        const dstDir = args.dstDir ?? process.env.MIGRATOR_DST_DIR;
        if (execute && !dstDir) {
          throw new Error(
            'Falta la carpeta del DESTINO: pasa dstDir (p.ej. /Users/horelvis/git/alfresco-dst-v2) o define ' +
              'MIGRATOR_DST_DIR. El content store y la BD de la version se montan ahi (<dstDir>/alf-data y <dstDir>/pg-data).',
          );
        }
        const running = execute && (await destinationRunning(host));
        if (execute && shouldSkipProvision(mode, running)) {
          return json({ mode, skipped: true, hops: 0, files: [], executed: false });
        }
        const hops = requireSupportedUpgradePath(project.source.version, project.target.version);
        const workDir = `${stateDir()}/provision`;
        const files: string[] = [];
        // VALIDAR los composes ANTES de parar nada: un compose invalido no debe dejar el destino caido.
        if (execute) {
          for (const hop of hops) {
            const invalid = await validateCompose(
              host,
              renderCompose(projectToComposeRequest(project, hop.to, args.withShare === true, undefined, dstDir)),
            );
            if (invalid) throw new Error(`Compose invalido para el hop ${hop.to}: ${invalid}`);
          }
        }
        // Ya validado: crea las carpetas de datos en el DESTINO y para los stacks que no tocan (liberar 8080).
        if (execute && dstDir) await ensureDataDirs(host, dstDir);
        const stopped = execute ? await stopRunningStacks(host) : [];
        const memTotal = await dockerMemTotal(host);
        const memory: AlfrescoMemory | undefined = memTotal ? computeAlfrescoMemory(memTotal) : undefined;
        for (const hop of hops) {
          const request = projectToComposeRequest(project, hop.to, args.withShare === true, memory, dstDir);
          if (execute) {
            const result = await provisionCompose(request, workDir, host);
            files.push(result.file);
          } else {
            files.push(await writeCompose(request, workDir));
          }
        }
        return json({ mode, skipped: false, hops: files.length, files, stopped, executed: execute });
      },
    }),
  );
}
