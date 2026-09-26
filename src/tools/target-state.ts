/**
 * Tool de ESTADO REAL del DESTINO (solo lectura): contenedores del proyecto, directorio de version,
 * content store, pg-data y version por REST. Es la via aprobada para inspeccionar el destino (la guarda de
 * shell bloquea `docker run` y demas mutaciones hechas a mano).
 */
import type { Context } from '@deepseek-ai/cordis';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { workspaceCwd } from '../infra/session.js';
import { loadProject } from '../domain/project-config.js';
import { composeProjectName } from '../domain/provision.js';
import { describeTargetState, parseTargetState, targetStateCommand } from '../domain/target-state.js';
import { discoverRest } from '../domain/assessment.js';
import { runShell, type HostRef } from '../infra/exec.js';

const text = (value: string) => [{ type: 'text' as const, text: value }];

function destinationHost(project: Awaited<ReturnType<typeof loadProject>>): HostRef {
  if (project.access.mode === 'local' || Object.keys(project.access.hosts).length === 0) return { name: 'local' };
  const name = process.env.MIGRATOR_DST_HOST ?? 'dst-app';
  const host = project.access.hosts[name];
  return host ? { name, host: host.host, user: host.user, keyFile: host.keyFile } : { name: 'local' };
}

export function registerTargetStateTools(ctx: Context): void {
  ctx.tools.register(
    defineTool({
      name: 'migrator_target_state',
      timeoutMs: 120_000,
      description:
        'ESTADO REAL del DESTINO en solo lectura: contenedores del proyecto, directorio de version (composes, JAR de modelos), ficheros del content store, datos en pg-data (carpetas de otros uid: contenedor efimero montado :ro) y version por REST. Usalo en lugar de ssh/docker a mano (la guarda de shell los bloquea).',
      parameters: {},
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => {
          const v = value as { summary: string; version?: string };
          return text(`${v.summary}\nversion REST: ${v.version ?? 'no responde'}`);
        },
      },
      async execute(_args, exec) {
        const project = await loadProject(undefined, workspaceCwd(exec));
        const host = destinationHost(project);
        const dataDir = project.target.dataDir ?? process.env.MIGRATOR_DST_DIR;
        const out = await runShell(host, targetStateCommand(composeProjectName(project.project), dataDir));
        const state = parseTargetState(out.stdout, dataDir);
        const baseUrl = process.env.MIGRATOR_DST_BASE_URL ?? project.target.baseUrl;
        const detected = baseUrl
          ? await discoverRest(baseUrl, process.env.MIGRATOR_DST_USER ?? process.env.MIGRATOR_SRC_USER, process.env.MIGRATOR_DST_PASSWORD ?? process.env.MIGRATOR_SRC_PASSWORD)
          : undefined;
        return JSON.parse(JSON.stringify({ ...state, ...(detected ? { version: detected.version } : {}), summary: describeTargetState(state) }));
      },
    }),
  );
}
