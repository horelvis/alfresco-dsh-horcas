/** Tool de guardas de seguridad: comprueba que el destino NO comparte BD/content store con el origen. */
import type { Context } from '@deepseek-ai/cordis';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { workspaceCwd } from '../infra/session.js';
import { loadProject } from '../domain/project-config.js';
import { assessDistinctTarget } from '../domain/guards.js';

const text = (value: string) => [{ type: 'text' as const, text: value }];
const json = <T>(value: T): never => JSON.parse(JSON.stringify(value)) as never;

export function registerGuardTools(ctx: Context): void {
  ctx.tools.register(
    defineTool({
      name: 'migrator_distinct_check',
      timeoutMs: 15_000,
      description:
        'Comprueba que el DESTINO no sea el MISMO que el origen (misma base de datos o mismo content store). Read-only; el resultado es BLOCKER si comparten.',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            blocked: { type: 'boolean' },
            findings: { type: 'array', items: { type: 'object', additionalProperties: true } },
          },
        },
        render: (_args, value) => {
          const v = value as { blocked: boolean; findings: Array<{ detail: string }> };
          return v.blocked
            ? text(`BLOQUEADO:\n${v.findings.map((f) => `- ${f.detail}`).join('\n')}`)
            : text('OK: el destino es distinto del origen');
        },
      },
      async execute(args, exec) {
        const project = await loadProject(undefined, workspaceCwd(exec));
        return json(assessDistinctTarget(project));
      },
    }),
  );
}
