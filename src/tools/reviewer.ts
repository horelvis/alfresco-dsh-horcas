/**
 * Tool del Master Reviewer: revisa artefactos y emite veredicto estructurado (anonimizado).
 */
import type { Context } from '@deepseek-ai/cordis';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { loadProject } from '../domain/project-config.js';
import { assessSource } from '../domain/assessment.js';
import { buildChecklist } from '../domain/checklist.js';
import { resolveUpgradePath } from '../domain/versions.js';
import { openAiCompatibleClient, review, type ReviewStage } from '../domain/reviewer.js';

const text = (value: string) => [{ type: 'text' as const, text: value }];
const json = <T>(value: T): never => JSON.parse(JSON.stringify(value)) as never;

export function registerReviewerTools(ctx: Context): void {
  ctx.tools.register(
    defineTool({
      name: 'migrator_review',
      description:
        'Master Reviewer LLM: revisa el plan/assessment/coherencia del proyecto y emite APPROVE/APPROVE_WITH_CONDITIONS/REJECT/ABSTAIN con hallazgos. Los datos se anonimizan antes de salir al LLM.',
      parameters: {
        project: { type: 'string', required: true },
        stage: { type: 'string', enum: ['PLAN', 'COHERENCE', 'ASSESSMENT', 'STATUS'], description: 'etapa (defecto PLAN)' },
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => {
          const v = value as { verdict: string; confidence: number; summary: string; findings: Array<{ severity: string; title: string }> };
          const findings = v.findings.map((f) => `  - [${f.severity}] ${f.title}`).join('\n');
          return text(`${v.verdict} (confianza ${v.confidence})\n${v.summary}${findings ? `\n${findings}` : ''}`);
        },
      },
      async execute(args) {
        const project = await loadProject(args.project);
        const hops = resolveUpgradePath(project.source.version, project.target.version);
        const assessment = await assessSource(project, {
          restUser: process.env.MIGRATOR_SRC_USER,
          restPassword: process.env.MIGRATOR_SRC_PASSWORD,
        });
        const checklist = buildChecklist({
          project: project.project,
          sourceVersion: project.source.version,
          targetVersion: project.target.version,
          sourceEdition: project.source.edition ?? 'CE',
          targetEdition: project.target.edition ?? 'CE',
          sourceSearch: project.source.search?.engine ?? 'solr',
          targetSearch: project.target.search?.engine ?? 'solr',
          hops: hops.map((h) => ({ from: h.from, to: h.to, pathClass: h.pathClass })),
        });

        const baseUrl = process.env.MIGRATOR_AI_BASE_URL ?? process.env.SPRING_AI_OPENAI_BASE_URL;
        const apiKey = process.env.MIGRATOR_AI_API_KEY ?? process.env.SPRING_AI_OPENAI_API_KEY;
        const model = process.env.MIGRATOR_AI_MODEL ?? process.env.SPRING_AI_OPENAI_CHAT_OPTIONS_MODEL ?? 'llm';
        const extraHeaders: Record<string, string> = {};
        if (process.env.MIGRATOR_AI_SESSION) extraHeaders['x-opencode-session'] = process.env.MIGRATOR_AI_SESSION;
        const client = baseUrl && apiKey ? openAiCompatibleClient(baseUrl, apiKey, model, extraHeaders) : undefined;

        const report = await review(
          {
            stage: (args.stage ?? 'PLAN') as ReviewStage,
            project: project.project,
            artifacts: {
              assessment: JSON.stringify(assessment),
              upgradePath: JSON.stringify(hops),
              checklist: JSON.stringify(checklist.map((i) => ({ text: i.text, status: i.status }))),
            },
          },
          { client, model },
        );
        return json(report);
      },
    }),
  );
}
