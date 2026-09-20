/**
 * Tool de BACKUP del origen (no destructivo): verifica-o-crea BD, content store (con manifiesto
 * SHA-256) y snapshot de config. No modifica el origen.
 */
import type { Context } from '@deepseek-ai/cordis';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { loadProject } from '../domain/project-config.js';
import { runBackup } from '../domain/backup.js';
import { stateDir } from '../domain/experience.js';

const text = (value: string) => [{ type: 'text' as const, text: value }];
const json = <T>(value: T): never => JSON.parse(JSON.stringify(value)) as never;

export function registerBackupTools(ctx: Context): void {
  ctx.tools.register(
    defineTool({
      name: 'migrator_backup',
      description:
        'Backup no destructivo del ORIGEN (verifica-o-crea): dump de BD, copia del content store + manifiesto SHA-256 y snapshot de config. El origen no se modifica.',
      parameters: {
        project: { type: 'string', required: true },
        execute: { type: 'boolean', description: 'false = planificar (dry-run, por defecto)' },
        backupDir: { type: 'string', description: 'Directorio de backup (defecto <state>/backup)' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: {
            backupDir: { type: 'string' },
            dryRun: { type: 'boolean' },
            complete: { type: 'boolean' },
            originRetained: { type: 'boolean' },
            artifacts: { type: 'array', items: { type: 'object', additionalProperties: true } },
          },
        },
        render: (_args, value) => {
          const v = value as { backupDir: string; complete: boolean; artifacts: Array<{ kind: string; location: string; note?: string; created: boolean; preexisting: boolean }> };
          const lines = v.artifacts.map(
            (a) => `- ${a.kind}: ${a.preexisting ? 'reutilizado' : a.created ? 'creado' : 'pendiente'}${a.note ? ` (${a.note})` : ''} · ${a.location}`,
          );
          return text(`backup=${v.backupDir} completo=${v.complete}\n${lines.join('\n')}`);
        },
      },
      async execute(args) {
        const project = await loadProject(args.project);
        const backupDir = args.backupDir ?? `${stateDir()}/backup`;
        const result = await runBackup({
          project,
          backupDir,
          host: { name: 'local' },
          dryRun: args.execute !== true,
        });
        return json(result);
      },
    }),
  );
}
