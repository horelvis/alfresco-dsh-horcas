/**
 * Tools de PLANIFICACION: estrategia, estimacion, checklist y export Jira.
 * Lee el inventario real del origen (JDBC read-only) para alimentar estrategia/estimacion.
 */
import type { Context } from '@deepseek-ai/cordis';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { workspaceCwd } from '../infra/session.js';
import { loadProject } from '../domain/project-config.js';
import { resolveUpgradePath } from '../domain/upgrade-paths.js';
import { recommendStrategy, type StrategyInput } from '../domain/strategy.js';
import { estimate, type EstimationInput } from '../domain/estimator.js';
import { applyEvidence, buildChecklist, renderChecklistMarkdown, type ChecklistInput } from '../domain/checklist.js';
import { checklistFacts, recordEvidence } from '../domain/evidence.js';
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

/** Ventana de corte: argumento de la tool o `estimation.cutoverWindowHours` del YAML. */
export function windowHours(arg: number | undefined, raw: Record<string, unknown>): { windowHours?: number } {
  const fromYaml = Number((raw.estimation as Record<string, unknown> | undefined)?.cutoverWindowHours);
  const value = arg ?? (Number.isFinite(fromYaml) ? fromYaml : undefined);
  return value !== undefined && value > 0 ? { windowHours: value } : {};
}

export function registerPlanningTools(ctx: Context): void {
  ctx.tools.register(
    defineTool({
      name: 'migrator_strategy',
      timeoutMs: 300_000,
      description: 'Recomienda estrategia de contenido/BD/indice segun el perfil del repositorio (C1-C5/D1-D2/I1-I2).',
      parameters: {},
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => {
          const v = value as { content: string; db: string; index: string; rationale: string; confidence: string };
          return text(`${v.content} / ${v.db} / ${v.index} (confianza ${v.confidence})\n${v.rationale}`);
        },
      },
      async execute(args, exec) {
        const project = await loadProject(undefined, workspaceCwd(exec));
        const inventory = await sourceInventory(project);
        return json(recommendStrategy(strategyInput(project, inventory)));
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'migrator_estimate',
      timeoutMs: 300_000,
      description:
        'Estima la ventana de migracion por fases (assessment/pre-staging/cutover/post), cuello y riesgos, y la POLITICA DE REINDEX segun tamaño y ventana de corte (online tras el corte / metadatos primero / pre-indexado + delta) con los pasos concretos del motor destino.',
      parameters: {
        changeRatePerDay: { type: 'number', description: 'Tasa de cambio diaria (defecto 0.01)' },
        parallelism: { type: 'number', description: 'Paralelismo (defecto 1)' },
        cutoverWindowHours: { type: 'number', description: 'Ventana de corte de PROD en horas (defecto estimation.cutoverWindowHours del YAML)' },
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => {
          const v = value as { cutoverMinutes: number; totalMinutes: number; bottleneck: string; confidence: string; risks: string[]; reindexPlan?: { policy: string; family: string; rationale: string; steps: string[] } };
          const r = v.reindexPlan;
          return text(
            `cutover=${v.cutoverMinutes}min total=${v.totalMinutes}min cuello=${v.bottleneck} confianza=${v.confidence}` +
              (v.risks.length ? `\nRiesgos: ${v.risks.join('; ')}` : '') +
              (r ? `\nReindex: ${r.policy} (${r.family}) — ${r.rationale}\n${r.steps.map((s) => `  - ${s}`).join('\n')}` : ''),
          );
        },
      },
      async execute(args, exec) {
        const project = await loadProject(undefined, workspaceCwd(exec));
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
          reindex: {
            engine: project.target.search?.engine ?? 'solr',
            edition: project.target.edition ?? 'CE',
            targetVersion: project.target.version,
            ...windowHours(args.cutoverWindowHours, project.raw),
          },
        };
        const result = estimate(input);
        await recordEvidence(stateDir(), project.project, 'estimate', 'OK', `estimacion calculada (${hops.length} hops)`);
        return json(result);
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'migrator_checklist',
      timeoutMs: 30_000,
      description: 'Genera la checklist pre/post-cutover segun version/edicion destino y motor de busqueda.',
      parameters: {
        format: { type: 'string', enum: ['md', 'json'], description: 'md (defecto) o json' },
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => {
          const v = value as { markdown: string; items: number };
          return text(v.markdown ?? `items=${v.items}`);
        },
      },
      async execute(args, exec) {
        const project = await loadProject(undefined, workspaceCwd(exec));
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
        // Estado resuelto con la EVIDENCIA durable (chequeos, checkpoints, hops): sin prueba sigue PENDING.
        const items = applyEvidence(buildChecklist(input), await checklistFacts(stateDir(), project.project, hops));
        return json({ items: items.length, markdown: renderChecklistMarkdown(project.project, items), checklist: items });
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'migrator_jira_export',
      timeoutMs: 15_000,
      description: 'Exporta epica + hops a un CSV importable por Jira (RFC 4180) en <state>/jira-import.csv.',
      parameters: {},
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { file: { type: 'string' }, rows: { type: 'number' } } },
        render: (_args, value) => text(`Escrito ${(value as { file: string }).file} (${(value as { rows: number }).rows} filas)`),
      },
      async execute(args, exec) {
        const project = await loadProject(undefined, workspaceCwd(exec));
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
