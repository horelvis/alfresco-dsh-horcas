/** Tools READ-ONLY del migrador. No escriben en el origen (Postgres solo SELECT). */
import type { Context } from '@deepseek-ai/cordis';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { availableVersions, loadSchemaReference } from '../domain/schema-reference.js';
import { compare, describe, liveCatalog } from '../domain/schema-integrity.js';
import { forCodes } from '../domain/recommendations.js';
import { breakingChangeGates, resolveUpgradePath } from '../domain/upgrade-paths.js';
import { dataDir } from '../domain/data-dir.js';
import { connectSource, queryRows, REPLICATION_SQL, sourceDbConfigFromEnv } from '../infra/pg.js';
import { recordEvidence } from '../domain/evidence.js';
import { stateDir } from '../domain/experience.js';
import { loadProject } from '../domain/project-config.js';
import { workspaceCwd } from '../infra/session.js';

const text = (value: string) => [{ type: 'text' as const, text: value }];

export function registerReadTools(ctx: Context): void {
  ctx.tools.register(
    defineTool({
      name: 'migrator_upgrade_path',
      timeoutMs: 15_000,
      description: 'Resuelve la ruta de upgrade soportada de Alfresco (no inventa rutas) y sus gates.',
      parameters: {
        from: { type: 'string', required: true, description: 'Version origen, p.ej. 7.1.0' },
        to: { type: 'string', required: true, description: 'Version destino, p.ej. 26.2' },
        edition: { type: 'string', description: 'CE o EE (afecta a gates como Solr-off)' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            hops: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  from: { type: 'string' },
                  to: { type: 'string' },
                  pathClass: { type: 'string' },
                  intermediate: { type: 'boolean' },
                  notes: { type: 'array', items: { type: 'string' } },
                },
              },
            },
            gates: { type: 'array', items: { type: 'string' } },
          },
        },
        render: (_args, value) => {
          const v = value as { hops: Array<{ from: string; to: string; pathClass: string; notes: string[] }>; gates: string[] };
          const lines = v.hops.map((h) => `- ${h.from} -> ${h.to} [${h.pathClass}]${h.notes.length ? ` (${h.notes.join('; ')})` : ''}`);
          return text(`${lines.join('\n')}\nGates destino: ${v.gates.join('; ')}`);
        },
      },
      async execute(args) {
        return {
          hops: resolveUpgradePath(args.from, args.to),
          gates: breakingChangeGates(args.to, args.edition ?? 'CE'),
        };
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'migrator_schema_versions',
      timeoutMs: 15_000,
      description: 'Lista las versiones de referencia de esquema disponibles (data/schema-references).',
      parameters: {},
      output: {
        schema: { type: 'array', items: { type: 'string' } },
        render: (_args, value) => text((value as string[]).join('\n')),
      },
      async execute() {
        return (await availableVersions(dataDir())).sort();
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'migrator_schema_check',
      timeoutMs: 300_000,
      description:
        'Comprueba PK/UNIQUE del esquema PostgreSQL del ORIGEN contra la referencia de su version (read-only).',
      parameters: {
        version: { type: 'string', required: true, description: 'Version ACS del origen, p.ej. 7.1.0' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: {
            healthy: { type: 'boolean' },
            referenceVersion: { type: 'string' },
            tablesChecked: { type: 'number' },
            replication: { type: 'number' },
            detail: { type: 'string' },
          },
        },
        render: (_args, value) => {
          const v = value as { healthy: boolean; detail: string; replication: number };
          return text(`${v.healthy ? 'OK' : 'DEFECTO'}: ${v.detail} | replicacion(CDC)=${v.replication}`);
        },
      },
      async execute(args, exec) {
        const reference = await loadSchemaReference(args.version, dataDir());
        const client = await connectSource(sourceDbConfigFromEnv());
        try {
          const integrity = compare(reference, await liveCatalog(client));
          const replicationRows = await queryRows(client, REPLICATION_SQL);
          const replication = Number(replicationRows[0]?.objects ?? 0);
          const project = await loadProject(undefined, workspaceCwd(exec)).then((p) => p.project).catch(() => undefined);
          if (project) {
            await recordEvidence(stateDir(), project, 'schema-pk', integrity.healthy ? 'OK' : 'FAIL',
              `${integrity.tablesChecked} tablas vs referencia ${integrity.referenceVersion}: ${integrity.healthy ? 'PK/UNIQUE completos' : `${integrity.mismatches.length} defectos`}`);
            await recordEvidence(stateDir(), project, 'cdc', replication === 0 ? 'OK' : 'FAIL',
              replication === 0 ? 'sin replicacion logica activa' : `${replication} objetos de replicacion logica activos`);
          }
          return {
            healthy: integrity.healthy,
            referenceVersion: integrity.referenceVersion,
            tablesChecked: integrity.tablesChecked,
            replication,
            detail: describe(integrity),
            mismatches: integrity.mismatches.map((m) => ({ ...m })),
          };
        } finally {
          await client.end();
        }
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'migrator_recommendations',
      timeoutMs: 15_000,
      description: 'Recomendaciones respaldadas por documentacion oficial para un conjunto de codigos de hallazgo.',
      parameters: {
        codes: { type: 'array', items: { type: 'string' }, required: true, description: 'Codigos, p.ej. COHERENCE_DANGLING' },
      },
      output: {
        schema: { type: 'array', items: { type: 'object', additionalProperties: true } },
        render: (_args, value) => {
          const recs = value as Array<{ title: string; code: string; actions: string[]; sources: Array<{ url: string }> }>;
          return text(
            recs
              .map((r) => `### ${r.title} (${r.code})\n${r.actions.map((a) => `- ${a}`).join('\n')}\nFuentes: ${r.sources.map((s) => s.url).join(', ')}`)
              .join('\n\n'),
          );
        },
      },
      async execute(args) {
        const recommendations = await forCodes(args.codes);
        return recommendations.map((r) => ({
          code: r.code,
          title: r.title,
          actions: [...r.actions],
          sources: r.sources.map((s) => ({ title: s.title, url: s.url })),
        }));
      },
    }),
  );
}
