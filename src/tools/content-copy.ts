/**
 * Tool de COPIA de contenido: planifica y ejecuta la copia del content store (rsync/S3/Azure, delta).
 * Los pasos de escritura requieren aprobacion.
 */
import type { Context } from '@deepseek-ai/cordis';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { workspaceCwd } from '../infra/session.js';
import { loadProject } from '../domain/project-config.js';
import { requireDistinctTarget } from '../domain/guards.js';
import { planContentCopy, type ContentStoreRef, type StoreType } from '../domain/content-copy.js';
import { resolveContentStorePath } from '../domain/content-store.js';
import { runShell, type HostRef } from '../infra/exec.js';

const text = (value: string) => [{ type: 'text' as const, text: value }];
const json = <T>(value: T): never => JSON.parse(JSON.stringify(value)) as never;

function destinationHost(project: Awaited<ReturnType<typeof loadProject>>): HostRef {
  if (project.access.mode === 'local' || Object.keys(project.access.hosts).length === 0) return { name: 'local' };
  const name = process.env.MIGRATOR_DST_HOST ?? 'dst-app';
  const host = project.access.hosts[name];
  return host ? { name, host: host.host, user: host.user, keyFile: host.keyFile } : { name: 'local' };
}

export function registerContentCopyTools(ctx: Context): void {
  ctx.tools.register(
    defineTool({
      name: 'migrator_copy_content',
      description:
        'Copia el content store del ORIGEN al DESTINO (rsync FS/SSH, aws s3 sync o azcopy). Con execute=true requiere aprobacion.',
      parameters: {
        project: { type: 'string', required: true },
        execute: { type: 'boolean', description: 'false = solo planificar (por defecto)' },
        delta: { type: 'boolean', description: 'copia incremental (delta) para el cutover' },
        bandwidthKbps: { type: 'number', description: 'limite de ancho de banda para rsync' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: {
            via: { type: 'string' },
            delta: { type: 'boolean' },
            command: { type: 'string' },
            executed: { type: 'boolean' },
          },
        },
        render: (_args, value) => {
          const v = value as { via: string; delta: boolean; command: string; executed: boolean };
          return text(`via=${v.via} delta=${v.delta} ejecutado=${v.executed}\n${v.command}`);
        },
      },
      async execute(args, exec) {
        const project = await loadProject(args.project, workspaceCwd(exec));
        if (args.execute === true) requireDistinctTarget(project);
        const sourceRef = project.source.contentStore;
        const targetRef = project.target.contentStore;
        const destination = destinationHost(project);
        const sshTarget =
          destination.name !== 'local' && destination.host
            ? `${destination.user ?? 'root'}@${destination.host}`
            : undefined;
        const ref = (store: { type?: string; path?: string; volume?: string } | undefined, resolved?: string): ContentStoreRef => ({
          type: (store?.type ?? 'FS') as StoreType,
          path: resolved ?? store?.path ?? (store?.volume ? `/${store.volume}` : undefined),
          bucket: (store as { bucket?: string } | undefined)?.bucket,
        });

        if (args.execute !== true) {
          const plan = planContentCopy(ref(sourceRef), ref(targetRef), {
            delta: args.delta === true,
            bandwidthKbps: args.bandwidthKbps,
            sshTarget,
            sshIdentity: destination.keyFile,
          });
          return json({ ...plan, executed: false });
        }

        const sourcePath = await resolveContentStorePath(sourceRef, { name: 'local' });
        const targetPath = await resolveContentStorePath(targetRef, destination);
        if (!sourcePath || !targetPath) {
          throw new Error('faltan rutas de content store (path o volume)');
        }
        const source = ref(sourceRef, sourcePath);
        const target = ref(targetRef, targetPath);
        const plan = planContentCopy(source, target, {
          delta: args.delta === true,
          bandwidthKbps: args.bandwidthKbps,
          sshTarget,
          sshIdentity: destination.keyFile,
        });
        const override = process.env.MIGRATOR_CONTENT_COPY_CMD;
        const command = override
          ? override.replaceAll('{source}', source.path ?? '').replaceAll('{target}', target.path ?? '')
          : plan.command;
        // El ORIGEN es local: la copia se lanza desde aqui (rsync empuja al destino por SSH).
        const result = await runShell({ name: 'local' }, command);
        if (result.exitCode !== 0) {
          throw new Error(`Copia de contenido fallida (exit=${result.exitCode}): ${result.stderr}`);
        }
        return json({ via: plan.via, delta: plan.delta, command, executed: true });
      },
    }),
  );
}
