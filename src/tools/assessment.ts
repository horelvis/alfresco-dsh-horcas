/**
 * Tool de ASSESSMENT: inventario del origen desde la fuente de verdad (REST discovery + JDBC + store).
 * Nunca consulta indices de busqueda.
 */
import type { Context } from '@deepseek-ai/cordis';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { loadProject } from '../domain/project-config.js';
import { assessSource } from '../domain/assessment.js';

const text = (value: string) => [{ type: 'text' as const, text: value }];
const json = <T>(value: T): never => JSON.parse(JSON.stringify(value)) as never;

export function registerAssessmentTools(ctx: Context): void {
  ctx.tools.register(
    defineTool({
      name: 'migrator_assess',
      description:
        'Inventario del ORIGEN desde la fuente de verdad: version/edicion (REST), nodos/auditoria/versiones/tamano BD (JDBC read-only) y ficheros/tamano del content store. Nunca usa indices de busqueda.',
      parameters: {
        project: { type: 'string', required: true },
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => {
          const v = value as { version: string; edition: string; nodes: number; audit: number; versions: number; fileCount: number; contentSizeBytes: number; dbSizeBytes: number; detected: Record<string, boolean>; notes: string[] };
          return text(
            `ACS ${v.version} ${v.edition} · nodos=${v.nodes} audit=${v.audit} versiones=${v.versions}` +
              ` · ficheros=${v.fileCount} contenido=${(v.contentSizeBytes / 1e9).toFixed(2)}GB BD=${(v.dbSizeBytes / 1e6).toFixed(1)}MB` +
              `\ndetectado: ${Object.entries(v.detected).map(([k, ok]) => `${k}=${ok ? 'ok' : 'no'}`).join(' ')}` +
              (v.notes.length ? `\nAvisos: ${v.notes.join('; ')}` : ''),
          );
        },
      },
      async execute(args) {
        const project = await loadProject(args.project);
        const assessment = await assessSource(project, {
          restUser: process.env.MIGRATOR_SRC_USER,
          restPassword: process.env.MIGRATOR_SRC_PASSWORD,
        });
        return json(assessment);
      },
    }),
  );
}
