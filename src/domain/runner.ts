/**
 * Runner de pasos: ejecuta la composicion que el agente decide, registra checkpoints (reanudable) y
 * respeta el guard de origen (nunca escribe en el origen).
 */
import { latestByStep, saveCheckpoint, type StepStatus } from './checkpoints.js';
import { stepById, type StepContext, type StepOutcome } from './steps.js';

export interface RunReport {
  runId: string;
  results: StepOutcome[];
  ok: boolean;
}

export interface RunnerOptions {
  /** Reanudar: omite pasos ya OK en el run. */
  resume?: boolean;
  dryRun?: boolean;
}

/** Comprueba que un paso de escritura no apunte al origen (defensa en profundidad). */
export function violatesSourceGuard(outcome: StepOutcome, destinationIsLocalSource: boolean): boolean {
  return destinationIsLocalSource && outcome.ok && outcome.command !== undefined;
}

export async function runSteps(
  ctx: StepContext,
  stepIds: string[],
  options: RunnerOptions = {},
): Promise<RunReport> {
  const results: StepOutcome[] = [];
  const done = options.resume ? await latestByStep(ctx.state, ctx.project.project, ctx.runId) : new Map();

  for (const id of stepIds) {
    const definition = stepById(id);
    if (!definition) {
      results.push({ step: id, ok: false, detail: `Paso desconocido: ${id}` });
      return { runId: ctx.runId, results, ok: false };
    }
    if (options.resume && done.get(id)?.status === 'OK') {
      results.push({ step: id, ok: true, detail: 'reanudado desde checkpoint', skipped: true });
      continue;
    }

    const started = Date.now();
    let outcome: StepOutcome;
    try {
      outcome = await definition.run({ ...ctx, dryRun: options.dryRun ?? ctx.dryRun }, {});
    } catch (error) {
      outcome = { step: id, ok: false, detail: String(error) };
    }
    outcome.step = id;

    const status: StepStatus = outcome.ok ? (outcome.skipped ? 'SKIPPED' : 'OK') : 'FAILED';
    await saveCheckpoint(ctx.state, {
      runId: ctx.runId,
      project: ctx.project.project,
      step: id,
      status,
      at: new Date().toISOString(),
      attempt: 1,
      detail: outcome.detail,
      durationMs: Date.now() - started,
    });
    results.push(outcome);
    if (!outcome.ok) {
      return { runId: ctx.runId, results, ok: false };
    }
  }
  return { runId: ctx.runId, results, ok: true };
}
