/**
 * Comando humano `/help` (registro de comandos del arnes): muestra la ayuda de arranque del migrador
 * DIRECTAMENTE, sin mensaje al modelo (no depende de que el LLM llame a `migrator_help`). Se monta como
 * sub-plugin con `inject: ['commands']`: solo existe en las UIs interactivas (CLI/Web); en headless no hay
 * servicio de comandos y el sub-plugin no se carga (el plugin principal sigue funcionando).
 */
import { helpText } from './domain/help.js';

interface CommandsContext {
  effect(fn: () => () => void, label?: string): void;
  commands: {
    register(definition: {
      name: string;
      description: string;
      handler: (invocation: { rawInput: string }) => Promise<{ kind: 'success' | 'error'; text: string }>;
    }): () => void;
  };
}

export const HelpCommand = {
  name: 'dsh-plugin-alfresco-migrator-help-command',
  inject: ['commands'],
  apply(ctx: CommandsContext): void {
    ctx.effect(
      () =>
        ctx.commands.register({
          name: 'help',
          description: 'Ayuda del migrador de Alfresco: frases de ejemplo y recordatorios de seguridad',
          handler: () => Promise.resolve({ kind: 'success', text: helpText() }),
        }),
      'alfresco-migrator: /help',
    );
  },
};
