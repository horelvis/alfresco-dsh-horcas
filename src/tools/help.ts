/**
 * Tool `migrator_help`: devuelve la ayuda de arranque (frases de ejemplo). Read-only, sin parametros.
 * Pensada para mostrarse al iniciar un chat o cuando el usuario pide ayuda.
 */
import type { Context } from '@deepseek-ai/cordis';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { helpText } from '../domain/help.js';

export function registerHelpTools(ctx: Context): void {
  ctx.tools.register(
    defineTool({
      name: 'migrator_help',
      timeoutMs: 5_000,
      description:
        'Ayuda de arranque para el usuario: frases de ejemplo ("iniciar migracion", "continuar migracion", "estado de la migracion"). Llamar al iniciar un chat o cuando el usuario pida ayuda.',
      parameters: {},
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text' as const, text: value as string }],
      },
      async execute() {
        return helpText();
      },
    }),
  );
}
