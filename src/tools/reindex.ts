/**
 * Tool de REINDEX: resuelve la estrategia, genera el prefixes-file y (con execute) lanza la
 * Reindexing app en el destino verificando el total indexado.
 */
import type { Context } from '@deepseek-ai/cordis';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { loadProject } from '../domain/project-config.js';
import { parseTotalIndexed, resolveReindexStrategy, reindexingAppCommand, scanModelsDirectory, writePrefixesFile } from '../domain/reindex.js';
import { runShell, substitute } from '../infra/exec.js';
import { stateDir } from '../domain/experience.js';
import type { HostRef } from '../infra/exec.js';

const text = (value: string) => [{ type: 'text' as const, text: value }];
const json = <T>(value: T): never => JSON.parse(JSON.stringify(value)) as never;

function destinationHost(project: Awaited<ReturnType<typeof loadProject>>): HostRef {
  if (project.access.mode === 'local' || Object.keys(project.access.hosts).length === 0) return { name: 'local' };
  const name = process.env.MIGRATOR_DST_HOST ?? 'dst-app';
  const host = project.access.hosts[name];
  return host ? { name, host: host.host, user: host.user, keyFile: host.keyFile } : { name: 'local' };
}

export function registerReindexTools(ctx: Context): void {
  ctx.tools.register(
    defineTool({
      name: 'migrator_reindex',
      description:
        'Regenera el indice de busqueda del DESTINO (nunca se migra): resuelve la estrategia, genera reindex.prefixes-file.json y lanza la Reindexing app (requiere aprobacion con execute=true).',
      parameters: {
        project: { type: 'string', required: true },
        modelsDir: { type: 'string', description: 'Directorio de modelos XML del destino (para el prefixes-file)' },
        execute: { type: 'boolean', description: 'false = solo planificar (por defecto)' },
        expectedIndexable: { type: 'number', description: 'Nodos indexables esperados (para verificar)' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: {
            strategy: { type: 'string' },
            prefixesFile: { type: 'string' },
            command: { type: 'array', items: { type: 'string' } },
            executed: { type: 'boolean' },
            indexed: { type: 'number' },
          },
        },
        render: (_args, value) => {
          const v = value as { strategy: string; prefixesFile: string; executed: boolean; indexed: number };
          return text(
            `estrategia=${v.strategy} prefixes=${v.prefixesFile} ejecutado=${v.executed}` +
              (v.indexed >= 0 ? ` indexados=${v.indexed}` : ''),
          );
        },
      },
      async execute(args) {
        const project = await loadProject(args.project);
        const last = project.target.version;
        const strategy = resolveReindexStrategy(project.target.search?.engine ?? 'opensearch', project.source.version, last);
        const modelsDir = args.modelsDir ?? process.env.MIGRATOR_DST_MODELS_DIR ?? '';
        const namespaces = modelsDir ? await scanModelsDirectory(modelsDir) : [];
        const prefixesFile = await writePrefixesFile(`${stateDir()}/reindex`, namespaces);

        const db = project.target.database;
        const command = reindexingAppCommand(strategy, {
          databaseUrl: process.env.MIGRATOR_DST_DB_URL ?? `jdbc:postgresql://${db?.host ?? 'localhost'}:${db?.port ?? 5432}/${db?.name ?? 'alfresco'}`,
          databaseUser: process.env.MIGRATOR_DST_DB_USER ?? db?.user ?? 'alfresco',
          searchUrl: process.env.MIGRATOR_DST_SEARCH_URL ?? 'http://search:9200',
          brokerUrl: process.env.MIGRATOR_DST_BROKER_URL ?? 'tcp://activemq:61616',
          prefixesFile,
          repositoryUrl: process.env.MIGRATOR_DST_REPO_URL ?? 'http://alfresco:8080/alfresco',
        });

        if (args.execute !== true) {
          return json({ strategy: strategy.kind, prefixesFile, command, executed: false, indexed: -1 });
        }
        const override = process.env.MIGRATOR_REINDEX_CMD;
        const shell = override
          ? substitute(override, { prefixesFile, dbUrl: command.find((c) => c.startsWith('--spring.datasource.url='))?.split('=')[1] ?? '' })
          : command.map((c) => (c.includes(' ') ? `"${c}"` : c)).join(' ');
        const result = await runShell(destinationHost(project), shell);
        if (result.exitCode !== 0) {
          throw new Error(`Reindexing app fallo (exit=${result.exitCode}): ${result.stderr}`);
        }
        const indexed = parseTotalIndexed(`${result.stdout}\n${result.stderr}`);
        const expected = args.expectedIndexable;
        if (expected !== undefined && indexed >= 0 && indexed !== expected) {
          throw new Error(`Total indexado ${indexed} != esperado ${expected}`);
        }
        return json({ strategy: strategy.kind, prefixesFile, command, executed: true, indexed });
      },
    }),
  );
}
