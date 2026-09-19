/**
 * Tools de PLANIFICACION: estrategia, estimacion, checklist y export Jira.
 * Lee el inventario real del origen (JDBC read-only) para alimentar estrategia/estimacion.
 */
import type { Context } from '@deepseek-ai/cordis';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { loadProject } from '../domain/project-config.js';
import { resolveUpgradePath } from '../domain/versions.js';
import { recommendStrategy, type StrategyInput } from '../domain/strategy.js';
import { estimate, type EstimationInput } from '../domain/estimator.js';
import { buildChecklist, renderChecklistMarkdown, type ChecklistInput } from '../domain/checklist.js';
import { epic, issue, writeCsv, type JiraRow } from '../domain/jira.js';
import { connectSource, queryRows, sourceDbConfigFromEnv } from '../infra/pg.js';
import { stateDir } from '../domain/experience.js';
import { assessSource } from '../domain/assessment.js';

const text = (value: string) => [{ type: 'text' as const, text: value }];

/** Normaliza un valor de dominio a JSON puro (lo que exige el schema de salida de dsh). */
const json = <T>(value: T): never => JSON.parse(JSON.stringify(value)) as never;

/** Inventario real del origen (fuente de verdad) para alimentar estrategia/estimacion. */
async function sourceInventory(project: Awaited<ReturnType<typeof loadProject>>) {
  return assessSource(project, {
    restUser: process.env.MIGRATOR_SRC_USER,
    restPassword: process.env.MIGRATOR_SRC_PASSWORD,
  });
}

function strategyInput(
  project: Awaited<ReturnType<typeof loadProject>>,
  inventory: { fileCount: number; contentSizeBytes: number; nodes: number },
): StrategyInput {
  const storageAccess = (project.source.contentStore?.via ?? 'local') !== 'local' || project.access.mode === 'ssh';
  return {
    fileCount: inventory.fileCount,
    sizeBytes: inventory.contentSizeBytes,
    nodes: inventory.nodes,
    storageAccess,
    transformRequired: false,
  };
}

export function registerPlanningTools(ctx: Context): void {
  ctx.tools.register(
    defineTool({
      name: 'migrator_strategy',
      description: 'Recomienda estrategia de contenido/BD/indice segun el perfil del repositorio (C1-C5/D1-D2/I1-I2).',
      parameters: { project: { type: 'string', required: true } },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => {
          const v = value as { content: string; db: string; index: string; rationale: string; confidence: string };
          return text(`${v.content} / ${v.db} / ${v.index} (confianza ${v.confidence})\n${v.rationale}`);
        },
      },
      async execute(args) {
        const project = await loadProject(args.project);
        const inventory = await sourceInventory(project);
        return json(recommendStrategy(strategyInput(project, inventory)));
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'migrator_estimate',
      description: 'Estima la ventana de migracion por fases (assessment/pre-staging/cutover/post), cuello y riesgos.',
      parameters: {
        project: { type: 'string', required: true },
        changeRatePerDay: { type: 'number', description: 'Tasa de cambio diaria (defecto 0.01)' },
        parallelism: { type: 'number', description: 'Paralelismo (defecto 1)' },
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => {
          const v = value as { cutoverMinutes: number; totalMinutes: number; bottleneck: string; confidence: string; risks: string[] };
          return text(
            `cutover=${v.cutoverMinutes}min total=${v.totalMinutes}min cuello=${v.bottleneck} confianza=${v.confidence}` +
              (v.risks.length ? `\nRiesgos: ${v.risks.join('; ')}` : ''),
          );
        },
      },
      async execute(args) {
        const project = await loadProject(args.project);
        const inventory = await sourceInventory(project);
        const hops = resolveUpgradePath(project.source.version, project.target.version);
        const input: EstimationInput = {
          contentBytes: inventory.contentSizeBytes,
          dbBytes: inventory.dbSizeBytes,
          nodes: inventory.nodes,
          auditCount: inventory.audit,
          hops: hops.length,
          requiresValidationHops: hops.filter((h) => h.pathClass === 'REQUIRES_VALIDATION').length,
          parallelism: args.parallelism ?? 1,
          changeRatePerDay: args.changeRatePerDay ?? 0.01,
        };
        return json(estimate(input));
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'migrator_checklist',
      description: 'Genera la checklist pre/post-cutover segun version/edicion destino y motor de busqueda.',
      parameters: {
        project: { type: 'string', required: true },
        format: { type: 'string', enum: ['md', 'json'], description: 'md (defecto) o json' },
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => {
          const v = value as { markdown: string; items: number };
          return text(v.markdown ?? `items=${v.items}`);
        },
      },
      async execute(args) {
        const project = await loadProject(args.project);
        const hops = resolveUpgradePath(project.source.version, project.target.version);
        const input: ChecklistInput = {
          project: project.project,
          sourceVersion: project.source.version,
          targetVersion: project.target.version,
          sourceEdition: project.source.edition ?? 'CE',
          targetEdition: project.target.edition ?? 'CE',
          sourceSearch: project.source.search?.engine ?? 'solr',
          targetSearch: project.target.search?.engine ?? 'solr',
          hops: hops.map((h) => ({ from: h.from, to: h.to, pathClass: h.pathClass })),
        };
        const items = buildChecklist(input);
        return json({ items: items.length, markdown: renderChecklistMarkdown(project.project, items), checklist: items });
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'migrator_jira_export',
      description: 'Exporta epica + hops a un CSV importable por Jira (RFC 4180) en <state>/jira-import.csv.',
      parameters: { project: { type: 'string', required: true } },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { file: { type: 'string' }, rows: { type: 'number' } } },
        render: (_args, value) => text(`Escrito ${(value as { file: string }).file} (${(value as { rows: number }).rows} filas)`),
      },
      async execute(args) {
        const project = await loadProject(args.project);
        const hops = resolveUpgradePath(project.source.version, project.target.version);
        const epicName = `Migracion ${project.project} a ACS ${project.target.version}`;
        const rows: JiraRow[] = [
          epic(epicName, 'alfresco,migracion', `Origen ${project.source.version} -> destino ${project.target.version}`),
          ...hops.map((h, index) =>
            issue(`Hop ${index + 1}: ${h.from} -> ${h.to} [${h.pathClass}]`, 'Task', h.pathClass === 'UNSUPPORTED' ? 'Highest' : 'High', 'migracion', h.notes.join('; '), epicName),
          ),
        ];
        const file = `${stateDir()}/jira-import.csv`;
        await writeCsv(file, rows);
        return { file, rows: rows.length };
      },
    }),
  );
}
