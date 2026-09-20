/**
 * Tool de VERIFICACION de paridad origen -> destino (read-only): conteos JDBC (nodos/refs) y content
 * store (ficheros/bytes). No escribe en origen ni destino; es evidencia para el GO/NO-GO del corte.
 */
import type { Context } from '@deepseek-ai/cordis';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { workspaceCwd } from '../infra/session.js';
import { loadProject } from '../domain/project-config.js';
import {
  localStoreInventory,
  remoteStoreInventory,
  sourceCounts,
  targetCounts,
  verifyParity,
  type CountCheck,
  type StoreCheck,
} from '../domain/verification.js';
import { resolveContentStorePath } from '../domain/content-store.js';
import type { HostRef } from '../infra/exec.js';

const text = (value: string) => [{ type: 'text' as const, text: value }];
const json = <T>(value: T): never => JSON.parse(JSON.stringify(value)) as never;

function destinationHost(project: Awaited<ReturnType<typeof loadProject>>): HostRef {
  if (project.access.mode === 'local' || Object.keys(project.access.hosts).length === 0) return { name: 'local' };
  const name = process.env.MIGRATOR_DST_HOST ?? 'dst-app';
  const host = project.access.hosts[name];
  return host ? { name, host: host.host, user: host.user, keyFile: host.keyFile } : { name: 'local' };
}

export function registerVerifyTools(ctx: Context): void {
  ctx.tools.register(
    defineTool({
      name: 'migrator_verify_target',
      timeoutMs: 300_000,
      description:
        'Verifica la paridad origen->destino tras la migracion: conteos JDBC (nodos, refs de contenido) y content store (ficheros/bytes). Read-only; no toca origen ni destino.',
      parameters: {
        tolerancePct: { type: 'number', description: 'Tolerancia porcentual por metrica (defecto 0 = exacto)' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: {
            project: { type: 'string' },
            verdict: { type: 'string' },
            counts: { type: 'array', items: { type: 'object', additionalProperties: true } },
            store: { type: 'array', items: { type: 'object', additionalProperties: true } },
            notes: { type: 'array', items: { type: 'string' } },
          },
        },
        render: (_args, value) => {
          const v = value as unknown as { verdict: string; counts: CountCheck[]; store: StoreCheck[]; notes: string[] };
          const line = (c: CountCheck | StoreCheck) =>
            `${c.ok ? 'x' : '!'} ${c.label}: origen=${c.source} destino=${c.target} delta=${c.delta}`;
          const notes = v.notes.length ? `\nnotas: ${v.notes.join('; ')}` : '';
          return text(`verdict=${v.verdict}\n${[...v.counts, ...v.store].map(line).join('\n')}${notes}`);
        },
      },
      async execute(args, exec) {
        const project = await loadProject(undefined, workspaceCwd(exec));
        const host = destinationHost(project);
        const sourceStore = project.source.contentStore;
        const targetStore = project.target.contentStore;
        const report = await verifyParity(
          project,
          {
            sourceCounts,
            targetCounts,
            sourceStore: async () => {
              const resolved = await resolveContentStorePath(sourceStore, { name: 'local' });
              return resolved ? localStoreInventory({ type: sourceStore?.type, path: resolved }) : undefined;
            },
            targetStore: async () => {
              const resolved = await resolveContentStorePath(targetStore, host);
              if (!resolved) return undefined;
              return host.name === 'local'
                ? localStoreInventory({ type: targetStore?.type, path: resolved })
                : remoteStoreInventory(host, resolved);
            },
          },
          args.tolerancePct ?? 0,
        );
        return json(report);
      },
    }),
  );
}
