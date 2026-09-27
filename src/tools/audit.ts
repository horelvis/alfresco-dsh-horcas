/**
 * Tool de AUDITORIA (Nivel 0): `migrator_audit` recalcula el estado del ensayo desde las FUENTES y
 * devuelve hallazgos (FAIL/WARN/INFO). Read-only (solo escribe el resultado en `.migrator/audit.jsonl`
 * para que la puerta del arnes, Nivel 2, lo exija antes del informe final / corte a PROD).
 */
import type { Context } from '@deepseek-ai/cordis';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { workspaceCwd } from '../infra/session.js';
import { loadProject } from '../domain/project-config.js';
import { stateDir } from '../domain/experience.js';
import { recordAudit, runAudit, type AuditResult } from '../domain/audit.js';

const text = (value: string) => [{ type: 'text' as const, text: value }];
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = (value: unknown): any => JSON.parse(JSON.stringify(value));

export function registerAuditTools(ctx: Context): void {
  ctx.tools.register(
    defineTool({
      name: 'migrator_audit',
      timeoutMs: 120_000,
      description:
        'Audita el ensayo contra el estado durable (checkpoints, hops, experiencia, journal, evidencia y checklist) y devuelve hallazgos FAIL/WARN/INFO. Read-only. Debe pasar (0 FAIL) antes de dar el informe por validado y antes del corte a PROD.',
      parameters: {},
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => {
          const v = value as unknown as AuditResult;
          const verdict = v.fails > 0 ? `${v.fails} FAIL / ${v.warns} WARN` : v.warns > 0 ? `0 FAIL / ${v.warns} WARN` : 'OK';
          const lines = v.findings.map((f) => `[${f.severity}] ${f.code}: ${f.detail}`);
          return text(`auditoria: ${verdict}\n${lines.join('\n')}`);
        },
      },
      async execute(_args, exec) {
        const project = await loadProject(undefined, workspaceCwd(exec));
        const result = await runAudit(project, stateDir());
        await recordAudit(stateDir(), result);
        return json(result);
      },
    }),
  );
}
