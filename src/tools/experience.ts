/**
 * Tools del flujo ENSAYO -> PRODUCCION (campanas con varios intentos).
 *
 * Una campana de ensayo (project+stage) acumula INTENTOS: ejecutas en PRE, falla un paso, restauras y
 * reanudas desde ese punto. Cada intento se registra con su resultado y punto de reanudacion.
 *
 * - `migrator_rehearsal_record`: registra un intento (ok/failed/aborted) con pasos y punto de reanudacion.
 * - `migrator_experience_latest`: consulta la campana y su historial de intentos.
 * - `migrator_environment_parity`: drift del origen actual respecto al ensayo.
 */
import type { Context } from '@deepseek-ai/cordis';
import { defineTool } from '@deepseek-ai/dsh-tools';
import {
  attemptSummary,
  campaignId,
  compareFingerprints,
  hasBlockingDrift,
  latestRehearsal,
  loadExperiences,
  recordAttempt,
  resumePoint,
  stateDir,
  type AttemptOutcome,
  type ExperienceAttempt,
  type Stage,
} from '../domain/experience.js';
import { gatherSourceFingerprint } from '../domain/fingerprint.js';
import { dataDir } from '../domain/data-dir.js';
import { loadProject } from '../domain/project-config.js';
import { workspaceCwd } from '../infra/session.js';

const text = (value: string) => [{ type: 'text' as const, text: value }];

export function registerExperienceTools(ctx: Context): void {
  ctx.tools.register(
    defineTool({
      name: 'migrator_rehearsal_record',
      timeoutMs: 120_000,
      description:
        'Registra un INTENTO de una migracion de PRUEBA (clone/TEST) en su campana: resultado, pasos y punto de reanudacion (para restaurar y reanudar).',
      parameters: {
        version: { type: 'string', required: true, description: 'Version ACS del origen ensayado' },
        targetVersion: { type: 'string', required: true },
        stage: { type: 'string', enum: ['clone', 'test', 'prod'], description: 'clone o test (por defecto test)' },
        runId: { type: 'string', description: 'runId del intento (correlaciona con checkpoints)' },
        outcome: { type: 'string', enum: ['ok', 'failed', 'aborted'], description: 'resultado del intento' },
        failedStep: { type: 'string', description: 'paso donde fallo (si aplica)' },
        resumeFrom: { type: 'string', description: 'paso desde el que reanudar (por defecto, el que fallo)' },
        steps: { type: 'array', items: { type: 'object', additionalProperties: true }, description: 'pasos ejecutados' },
        notes: { type: 'string' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: {
            id: { type: 'string' },
            stage: { type: 'string' },
            validated: { type: 'boolean' },
            attempts: { type: 'number' },
            resumeFrom: { type: 'string' },
          },
        },
        render: (_args, value) => {
          const r = value as { id: string; stage: string; validated: boolean; attempts: number; resumeFrom?: string; history: string };
          return text(
            `Campana ${r.id} stage=${r.stage} validada=${r.validated} intentos=${r.attempts}` +
              `${r.resumeFrom ? ` · reanudar en ${r.resumeFrom}` : ''}\n${r.history}`,
          );
        },
      },
      async execute(args, exec) {
        const projectName = (await loadProject(undefined, workspaceCwd(exec))).project;
        const stage = (args.stage ?? 'test') as Stage;
        const outcome = (args.outcome ?? 'ok') as AttemptOutcome;
        const fingerprint = await gatherSourceFingerprint(args.version, dataDir());
        const now = new Date().toISOString();
        const attempt: ExperienceAttempt = {
          id: args.runId ?? `${campaignId(projectName, stage)}-${Date.now()}`,
          at: now,
          outcome,
          failedStep: args.failedStep,
          resumeFrom: args.resumeFrom ?? args.failedStep,
          steps: (args.steps ?? []).map((s) => ({
            id: String((s as Record<string, unknown>).id ?? ''),
            ok: Boolean((s as Record<string, unknown>).ok),
            durationMs: Number((s as Record<string, unknown>).durationMs ?? 0),
            detail: (s as Record<string, unknown>).detail ? String((s as Record<string, unknown>).detail) : undefined,
          })),
          findings: [],
          notes: args.notes,
        };
        const record = await recordAttempt(stateDir(), {
          project: projectName,
          stage,
          sourceVersion: args.version,
          targetVersion: args.targetVersion,
          fingerprint,
          attempt,
        });
        return {
          id: record.id,
          stage: record.stage,
          validated: record.validated,
          attempts: record.attempts.length,
          resumeFrom: resumePoint(record) ?? '',
          history: attemptSummary(record),
        };
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'migrator_experience_latest',
      timeoutMs: 15_000,
      description: 'Devuelve la campana de ensayo del proyecto (opcionalmente por stage) y su historial de intentos.',
      parameters: {
        stage: { type: 'string', enum: ['clone', 'test', 'prod'] },
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => {
          const v = value as { found: boolean; history?: string; attempts?: number; validated?: boolean };
          return text(v.found ? `intentos=${v.attempts} validada=${v.validated}\n${v.history}` : 'Sin experiencia registrada');
        },
      },
      async execute(args, exec) {
        const projectName = (await loadProject(undefined, workspaceCwd(exec))).project;
        const records = await loadExperiences(stateDir(), projectName);
        const filtered = args.stage ? records.filter((r) => r.stage === args.stage) : records;
        const latest = filtered.sort((a, b) => a.updatedAt.localeCompare(b.updatedAt)).at(-1);
        return latest
          ? { found: true, ...JSON.parse(JSON.stringify(latest)), attempts: latest.attempts.length, history: attemptSummary(latest) }
          : { found: false };
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'migrator_environment_parity',
      timeoutMs: 120_000,
      description:
        'Compara el origen actual con el ultimo ensayo validado y devuelve el drift (BLOCKER impide ejecutar en PROD).',
      parameters: {
        version: { type: 'string', required: true, description: 'Version ACS del origen actual' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: {
            hasRehearsal: { type: 'boolean' },
            rehearsalId: { type: 'string' },
            blocking: { type: 'boolean' },
            drift: { type: 'array', items: { type: 'object', additionalProperties: true } },
          },
        },
        render: (_args, value) => {
          const v = value as { hasRehearsal: boolean; rehearsalId?: string; blocking: boolean; drift: Array<{ kind: string; severity: string; detail: string }> };
          if (!v.hasRehearsal) return text('Sin ensayo validado: PROD no debe ejecutarse.');
          const lines = v.drift.map((d) => `- [${d.severity}] ${d.kind}: ${d.detail}`);
          return text(`Ensayo ${v.rehearsalId} · blocking=${v.blocking}\n${lines.join('\n') || '(sin drift)'}`);
        },
      },
      async execute(args, exec) {
        const projectName = (await loadProject(undefined, workspaceCwd(exec))).project;
        const rehearsal = await latestRehearsal(stateDir(), projectName);
        if (!rehearsal) {
          return { hasRehearsal: false, rehearsalId: '', blocking: true, drift: [] };
        }
        const current = await gatherSourceFingerprint(args.version, dataDir());
        const drift = compareFingerprints(rehearsal.fingerprint, current);
        return {
          hasRehearsal: true,
          rehearsalId: rehearsal.id,
          blocking: hasBlockingDrift(drift),
          drift: drift.map((d) => ({ ...d })),
        };
      },
    }),
  );
}
