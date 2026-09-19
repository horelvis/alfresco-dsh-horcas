/**
 * Tool de COPIA de contenido: planifica y ejecuta la copia del content store (rsync/S3/Azure, delta).
 * Los pasos de escritura requieren aprobacion.
 */
import type { Context } from '@deepseek-ai/cordis';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { loadProject } from '../domain/project-config.js';
import { planContentCopy, type ContentStoreRef, type StoreType } from '../domain/content-copy.js';
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
      async execute(args) {
        const project = await loadProject(args.project);
        const source: ContentStoreRef = {
          type: (project.source.contentStore?.type ?? 'FS') as StoreType,
          path: project.source.contentStore?.path,
          bucket: (project.source.contentStore as { bucket?: string } | undefined)?.bucket,
        };
        const target: ContentStoreRef = {
          type: (project.target.contentStore?.type ?? 'FS') as StoreType,
          path: project.target.contentStore?.path,
          bucket: (project.target.contentStore as { bucket?: string } | undefined)?.bucket,
        };
        const plan = planContentCopy(source, target, {
          delta: args.delta === true,
          bandwidthKbps: args.bandwidthKbps,
        });
        if (args.execute !== true) {
          return json({ ...plan, executed: false });
        }
        const override = process.env.MIGRATOR_CONTENT_COPY_CMD;
        const command = override
          ? override.replaceAll('{source}', source.path ?? '').replaceAll('{target}', target.path ?? '')
          : plan.command;
        const result = await runShell(destinationHost(project), command);
        if (result.exitCode !== 0) {
          throw new Error(`Copia de contenido fallida (exit=${result.exitCode}): ${result.stderr}`);
        }
        return json({ via: plan.via, delta: plan.delta, command, executed: true });
      },
    }),
  );
}
