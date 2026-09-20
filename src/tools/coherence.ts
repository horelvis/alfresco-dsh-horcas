/** Tools de coherencia y forense de colgantes (read-only). Cierran el hueco detectado: explicar que nodo hay detras. */
import type { Context } from '@deepseek-ai/cordis';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { checkCoherence, coherenceBlocked, explainMissing } from '../domain/coherence.js';
import { loadProject } from '../domain/project-config.js';

const text = (value: string) => [{ type: 'text' as const, text: value }];

async function storeRoot(projectPath: string): Promise<string> {
  const project = await loadProject(projectPath);
  const storePath = project.source.contentStore?.path;
  if (!storePath) throw new Error('El proyecto no define source.contentStore.path');
  return storePath;
}

export function registerCoherenceTools(ctx: Context): void {
  ctx.tools.register(
    defineTool({
      name: 'migrator_coherence',
      timeoutMs: 300_000,
      description: 'Coherencia DB<->content store del origen (refs, dangling, orphans, verdict). Read-only.',
      parameters: {
        project: { type: 'string', required: true },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            refs: { type: 'number' },
            storeObjects: { type: 'number' },
            dangling: { type: 'number' },
            orphans: { type: 'number' },
            sizeMismatch: { type: 'number' },
            verdict: { type: 'string' },
            samples: { type: 'array', items: { type: 'string' } },
            policy: { type: 'string' },
            blocked: { type: 'boolean' },
          },
        },
        render: (_args, value) => {
          const v = value as { refs: number; storeObjects: number; dangling: number; orphans: number; sizeMismatch: number; verdict: string; policy: string; blocked: boolean };
          return text(
            `refs=${v.refs} storeObjects=${v.storeObjects} dangling=${v.dangling} orphans=${v.orphans} ` +
              `sizeMismatch=${v.sizeMismatch} verdict=${v.verdict} policy=${v.policy} bloqueado=${v.blocked}`,
          );
        },
      },
      async execute(args) {
        const project = await loadProject(args.project);
        const report = await checkCoherence(await storeRoot(args.project));
        const policy = project.migration.coherencePolicy ?? 'FAIL_ON_DANGLING';
        return { ...report, policy, blocked: coherenceBlocked(policy, report.dangling) };
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'migrator_dangling_explain',
      timeoutMs: 300_000,
      description:
        'Para cada referencia colgante, resuelve el nodo vivo/version/papelera y la ruta del documento (evidencia para decidir).',
      parameters: {
        project: { type: 'string', required: true },
      },
      output: {
        schema: { type: 'array', items: { type: 'object', additionalProperties: true } },
        render: (_args, value) => {
          const items = value as Array<{ contentUrl: string; liveReferenced: boolean; references: Array<{ role: string; type: string; name: string; path: string }> }>;
          if (items.length === 0) return text('Sin referencias colgantes.');
          return text(
            items
              .map((d) => {
                const refs = d.references.map((r) => `  - [${r.role}] ${r.type} ${r.path}${r.name ? ` (${r.name})` : ''}`).join('\n');
                return `${d.contentUrl} · vivo=${d.liveReferenced}\n${refs}`;
              })
              .join('\n\n'),
          );
        },
      },
      async execute(args) {
        const items = await explainMissing(await storeRoot(args.project));
        return items.map((d) => ({
          contentUrl: d.contentUrl,
          sizeBytes: d.sizeBytes,
          markedOrphan: d.markedOrphan,
          roles: [...d.roles],
          liveReferenced: d.liveReferenced,
          references: d.references.map((r) => ({ ...r })),
        }));
      },
    }),
  );
}
