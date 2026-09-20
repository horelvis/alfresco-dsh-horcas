/**
 * Tool del WIZARD: genera/valida el YAML de proyecto contra el JSON Schema y previsualiza la ruta.
 */
import type { Context } from '@deepseek-ai/cordis';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { workspaceCwd } from '../infra/session.js';
import { runWizard, validateProject } from '../domain/wizard.js';

const text = (value: string) => [{ type: 'text' as const, text: value }];
const json = <T>(value: T): never => JSON.parse(JSON.stringify(value)) as never;

export function registerWizardTools(ctx: Context): void {
  ctx.tools.register(
    defineTool({
      name: 'migrator_wizard',
      description:
        'Genera y valida el YAML de proyecto contra el JSON Schema (con deteccion opcional del origen) y previsualiza la ruta de upgrade. Con dryRun=true solo valida y muestra.',
      parameters: {
        name: { type: 'string', description: 'Nombre del proyecto' },
        baseUrl: { type: 'string', description: 'URL del origen (/alfresco)' },
        version: { type: 'string', description: 'Version ACS del origen' },
        edition: { type: 'string', enum: ['CE', 'EE'] },
        targetVersion: { type: 'string', description: 'Version destino (defecto 26.2)' },
        dbEngine: { type: 'string' }, dbHost: { type: 'string' }, dbPort: { type: 'number' },
        dbName: { type: 'string' }, dbUser: { type: 'string' },
        storeType: { type: 'string', enum: ['FS', 'S3', 'AZURE'] },
        storePath: { type: 'string' },
        sourceSearch: { type: 'string' }, targetSearch: { type: 'string' },
        detect: { type: 'boolean', description: 'consultar el Discovery REST del origen' },
        dryRun: { type: 'boolean', description: 'solo validar/previsualizar (no escribir)' },
        out: { type: 'string', description: 'ruta de salida del YAML' },
        force: { type: 'boolean', description: 'sobrescribir si existe' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: {
            project: { type: 'string' },
            errors: { type: 'array', items: { type: 'string' } },
            hops: { type: 'array', items: { type: 'string' } },
            note: { type: 'string' },
            yaml: { type: 'string' },
          },
        },
        render: (_args, value) => {
          const v = value as { project: string; errors: string[]; hops: string[]; note: string; yaml?: string };
          if (v.errors.length) {
            return text(`INVALIDO (${v.project}):\n${v.errors.map((e) => `- ${e}`).join('\n')}`);
          }
          return text(`${v.project}: ${v.note}\nRuta: ${v.hops.join(' ; ')}${v.yaml ? `\n\n${v.yaml}` : ''}`);
        },
      },
      async execute(args, exec) {
        const result = await runWizard({
          inputs: {
            name: args.name,
            baseUrl: args.baseUrl,
            version: args.version,
            edition: args.edition,
            targetVersion: args.targetVersion,
            dbEngine: args.dbEngine,
            dbHost: args.dbHost,
            dbPort: args.dbPort,
            dbName: args.dbName,
            dbUser: args.dbUser,
            storeType: args.storeType,
            storePath: args.storePath,
            sourceSearch: args.sourceSearch,
            targetSearch: args.targetSearch,
            detect: args.detect === true,
          },
          dryRun: args.dryRun !== false,
          out: args.out,
          force: args.force === true,
        });
        return json({ project: result.project, errors: result.errors, hops: result.preview.hops, note: result.preview.note, yaml: result.yaml });
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'migrator_validate',
      timeoutMs: 15_000,
      description: 'Valida un objeto YAML de proyecto contra el JSON Schema (sin ejecutar nada).',
      parameters: {
        project: { type: 'string', required: true, description: 'Ruta del YAML a validar' },
      },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { valid: { type: 'boolean' }, errors: { type: 'array', items: { type: 'string' } } } },
        render: (_args, value) => {
          const v = value as { valid: boolean; errors: string[] };
          return text(v.valid ? 'VALIDO' : `INVALIDO:\n${v.errors.map((e) => `- ${e}`).join('\n')}`);
        },
      },
      async execute(args, exec) {
        const { loadProject } = await import('../domain/project-config.js');
        const project = await loadProject(args.project, workspaceCwd(exec));
        const errors = await validateProject(project.raw);
        return json({ valid: errors.length === 0, errors });
      },
    }),
  );
}
