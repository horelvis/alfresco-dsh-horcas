/**
 * Tools de ESCRITURA del migrador. Actuan SOLO sobre el DESTINO y requieren aprobacion humana
 * (la politica `tools/pre-execute` las marca `ask`; el guard bloquea cualquier intento sobre el origen).
 *
 * Estado: `migrator_target` resuelve y valida el plan (dry-run) sin ejecutar todavia el pipeline de
 * destino, que se porta por fases.
 */
import type { Context } from '@deepseek-ai/cordis';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { loadProject } from '../domain/project-config.js';
import { resolveUpgradePath } from '../domain/versions.js';
import { loadSchemaReference } from '../domain/schema-reference.js';
import { dataDir } from '../domain/data-dir.js';

const text = (value: string) => [{ type: 'text' as const, text: value }];

export function registerWriteTools(ctx: Context): void {
  ctx.tools.register(
    defineTool({
      name: 'migrator_target',
      description:
        'Prepara el destino para la migracion. Solo DESTINO (nunca el origen). Con execute=false valida y devuelve el plan (dry-run).',
      parameters: {
        project: { type: 'string', required: true, description: 'Ruta del YAML de proyecto' },
        execute: { type: 'boolean', description: 'true = ejecuta (requiere aprobacion); por defecto false' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            project: { type: 'string' },
            hops: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  from: { type: 'string' },
                  to: { type: 'string' },
                  pathClass: { type: 'string' },
                },
              },
            },
            referenceVersion: { type: 'string' },
            executed: { type: 'boolean' },
          },
        },
        render: (_args, value) => {
          const v = value as { project: string; hops: Array<{ from: string; to: string; pathClass: string }>; referenceVersion: string; executed: boolean };
          const hops = v.hops.map((h) => `  ${h.from} -> ${h.to} [${h.pathClass}]`).join('\n');
          return text(`Proyecto ${v.project} · referencia esquema ${v.referenceVersion} · ejecutado=${v.executed}\n${hops}`);
        },
      },
      async execute(args) {
        const config = await loadProject(args.project);
        const hops = resolveUpgradePath(config.source.version, config.target.version);
        const reference = await loadSchemaReference(config.source.version, dataDir());
        if (args.execute === true) {
          throw new Error('migrator_target: la ejecucion del pipeline de destino aun no esta portada (fase 2)');
        }
        return {
          project: config.project,
          hops: hops.map((h) => ({ from: h.from, to: h.to, pathClass: h.pathClass })),
          referenceVersion: reference.version,
          executed: false,
        };
      },
    }),
  );
}
