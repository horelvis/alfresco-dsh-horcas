/**
 * Checkpoints durables: permiten reanudar y dan al agente memoria de lo ya hecho
 * (idempotencia por paso). Formato JSONL append-only en `.migrator/checkpoints.jsonl`.
 */
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';

export type StepStatus = 'OK' | 'FAILED' | 'SKIPPED';

export interface Checkpoint {
  runId: string;
  project: string;
  step: string;
  status: StepStatus;
  at: string;
  attempt: number;
  detail?: string;
  durationMs?: number;
}

export function checkpointsFile(state: string): string {
  return path.join(state, 'checkpoints.jsonl');
}

export async function saveCheckpoint(state: string, checkpoint: Checkpoint): Promise<void> {
  await mkdir(state, { recursive: true });
  await appendFile(checkpointsFile(state), JSON.stringify(checkpoint) + '\n', 'utf8');
}

export async function loadCheckpoints(state: string, project?: string, runId?: string): Promise<Checkpoint[]> {
  let text: string;
  try {
    text = await readFile(checkpointsFile(state), 'utf8');
  } catch {
    return [];
  }
  return text
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as Checkpoint)
    .filter((c) => (!project || c.project === project) && (!runId || c.runId === runId));
}

/** `runId` del checkpoint mas reciente del proyecto (evita exigir el id al consultar el estado). */
export async function latestRunId(state: string, project?: string): Promise<string | undefined> {
  let latest: Checkpoint | undefined;
  for (const checkpoint of await loadCheckpoints(state, project)) {
    if (!latest || checkpoint.at > latest.at) latest = checkpoint;
  }
  return latest?.runId;
}

/** Ultimo estado por paso (para saber que esta hecho y poder reanudar). */
export async function latestByStep(state: string, project: string, runId: string): Promise<Map<string, Checkpoint>> {
  const map = new Map<string, Checkpoint>();
  for (const checkpoint of await loadCheckpoints(state, project, runId)) {
    map.set(checkpoint.step, checkpoint);
  }
  return map;
}

export async function isDone(state: string, project: string, runId: string, step: string): Promise<boolean> {
  return (await latestByStep(state, project, runId)).get(step)?.status === 'OK';
}
