/**
 * Memoria durable entre chats: `migrator_journal` anota hitos y `migrator_resume` devuelve "donde
 * estamos" + la siguiente accion. Con esto, `continuar migracion` en un chat nuevo retoma sin repetir
 * el assessment. Solo tocan el estado LOCAL (`.migrator`).
 */
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { workspaceCwd } from '../infra/session.js';
import { loadProject } from '../domain/project-config.js';
import { stateDir, loadExperiences, resumePoint, attemptSummary } from '../domain/experience.js';
import { latestRunId, loadCheckpoints } from '../domain/checkpoints.js';
import { requireSupportedUpgradePath } from '../domain/upgrade-paths.js';
import { checkHopAlignment, loadHopProgress, nextHop } from '../domain/hops.js';
import { discoverRest } from '../domain/assessment.js';
import { appendJournal, latestJournal, loadJournal } from '../domain/journal.js';
import { backupStatus, nextAction, recentSessions } from '../domain/resume.js';

const text = (value: string) => [{ type: 'text' as const, text: value }];
/** El arnes exige salida JSON *lossless*: round-trip que elimina `undefined` y tipos no serializables. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = (value: unknown): any => JSON.parse(JSON.stringify(value));

export function registerJournalTools(ctx: Context): void {
  ctx.tools.register(
    defineTool({
      name: 'migrator_journal',
      timeoutMs: 15_000,
      description:
        'Anota un HITO de la migracion en el estado local (.migrator/journal.jsonl): resumen del assessment, estrategia, plan, decision, bloqueo o aprobacion. Memoria durable para retomar en otro chat.',
      parameters: {
        kind: { type: 'string', required: true, description: 'assessment | strategy | plan | decision | blocker | approval | note' },
        summary: { type: 'string', required: true, description: 'resumen de una linea del hito' },
        data: { type: 'object', additionalProperties: true, description: 'datos libres del hito (opcional)' },
      },
      output: {
        schema: { type: 'object', additionalProperties: true, properties: { at: { type: 'string' }, kind: { type: 'string' }, summary: { type: 'string' } } },
        render: (_args, value) => {
          const v = value as { at: string; kind: string; summary: string };
          return text(`journal[${v.kind}] ${v.at}: ${v.summary}`);
        },
      },
      async execute(args, exec) {
        const project = await loadProject(undefined, workspaceCwd(exec));
        const entry = await appendJournal(stateDir(), {
          project: project.project,
          kind: args.kind,
          summary: args.summary,
          ...(args.data ? { data: args.data as Record<string, unknown> } : {}),
        });
        return json(entry);
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'migrator_resume',
      timeoutMs: 60_000,
      description:
        'Devuelve "donde estamos" para CONTINUAR en un chat nuevo: proyecto/stage, ruta y hops (hechos/pendientes), ultimos checkpoints, ultimo intento, journal, backup, composes y version del DESTINO, mas la siguiente accion recomendada. Read-only.',
      parameters: {},
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => {
          const v = value as {
            hasProject: boolean;
            project?: string;
            stage?: string;
            route?: string[];
            hopsDone?: string[];
            hopPending?: string;
            destinationVersion?: string;
            hopOk?: boolean;
            lastRunId?: string;
            resumeFrom?: string;
            backup?: { present: boolean };
            journal?: { kind: string; summary: string; at: string };
            journalStale?: boolean;
            sessions?: string[];
            nextAction: string;
          };
          if (!v.hasProject) return text(`Sin proyecto en el workspace.\nSiguiente: ${v.nextAction}`);
          const lines = [
            `proyecto=${v.project} stage=${v.stage}`,
            `ruta=${(v.route ?? []).join(' -> ')}`,
            `hops hechos=[${(v.hopsDone ?? []).join(', ')}] pendiente=${v.hopPending ?? '-'}`,
            `destino=${v.destinationVersion ?? '?'} hopOk=${v.hopOk === undefined ? '?' : v.hopOk}`,
            `run=${v.lastRunId ?? '-'} reanudar=${v.resumeFrom ?? '-'}`,
            `backup=${v.backup?.present ? 'presente' : 'ausente'}`,
            v.journal ? `journal[${v.journal.kind}]: ${v.journal.summary}` : 'journal=(vacio)',
            v.journalStale ? 'AVISO: el journal contradice los HECHOS vivos (manda el estado actual); anota un hito nuevo.' : '',
            v.sessions && v.sessions.length ? `sesiones previas: ${v.sessions.join(', ')}` : '',
            `SIGUIENTE: ${v.nextAction}`,
          ].filter(Boolean);
          return text(lines.join('\n'));
        },
      },
      async execute(_args, exec) {
        const cwd = workspaceCwd(exec);
        const state = stateDir();
        let project;
        try {
          project = await loadProject(undefined, cwd);
        } catch {
          return { hasProject: false, nextAction: nextAction({ hasProject: false, hops: 0, backupComplete: false }) };
        }

        const hops = requireSupportedUpgradePath(project.source.version, project.target.version);
        const progress = await loadHopProgress(state, project.project);
        const done = new Set(progress.map((p) => p.to));
        const pending = nextHop(hops, done);

        const runId = await latestRunId(state, project.project);
        const checkpoints = runId ? await loadCheckpoints(state, project.project, runId) : [];
        const latest = new Map<string, (typeof checkpoints)[number]>();
        for (const c of checkpoints) latest.set(c.step, c);

        const experiences = await loadExperiences(state, project.project);
        const last = experiences.at(-1);
        const resumeFrom = resumePoint(last);

        const journal = await latestJournal(state, project.project);
        const backup = await backupStatus(path.join(state, 'backup'), project.project);

        let composes: string[] = [];
        try {
          composes = (await readdir(path.join(state, 'provision'))).filter((f) => f.endsWith('.yml')).sort();
        } catch {
          composes = [];
        }

        const baseUrl = project.target.baseUrl ?? process.env.MIGRATOR_DST_BASE_URL;
        const detected = baseUrl
          ? await discoverRest(
              baseUrl,
              process.env.MIGRATOR_DST_USER ?? process.env.MIGRATOR_SRC_USER,
              process.env.MIGRATOR_DST_PASSWORD ?? process.env.MIGRATOR_SRC_PASSWORD,
            )
          : undefined;
        const alignment = checkHopAlignment(hops, done, detected?.version, project.target.version);

        const backupComplete = backup.db && backup.contentStore && backup.config;
        // Si el journal dice "blocker" pero los HECHOS vivos cuadran, el hito es obsoleto: manda el estado actual.
        const journalStale = journal?.kind === 'blocker' && alignment.ok && detected !== undefined;
        return json({
          hasProject: true,
          project: project.project,
          stage: project.stage,
          route: hops.map((h) => `${h.from}->${h.to}`),
          hopsDone: [...done],
          hopPending: pending?.to ?? project.target.version,
          destinationVersion: detected?.version,
          hopOk: alignment.ok,
          checkpoints: [...latest.values()].map((c) => ({ step: c.step, status: c.status, detail: c.detail ?? '' })),
          lastRunId: runId,
          resumeFrom,
          lastAttempt: last ? attemptSummary(last) : undefined,
          backup: { present: backup.present, complete: backupComplete, db: backup.db, contentStore: backup.contentStore, config: backup.config },
          provisionComposes: composes,
          journal: journal ? { kind: journal.kind, summary: journal.summary, at: journal.at } : undefined,
          journalStale,
          journalEntries: (await loadJournal(state, project.project)).length,
          sessions: await recentSessions(cwd),
          nextAction: nextAction({
            hasProject: true,
            hops: hops.length,
            hopPending: pending?.to ?? project.target.version,
            hopOk: alignment.ok,
            destinationVersion: detected?.version,
            resumeFrom,
            backupComplete,
          }),
        });
      },
    }),
  );
}
