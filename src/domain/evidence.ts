/**
 * EVIDENCIA durable de las comprobaciones (`.migrator/evidence.jsonl`): cada tool de chequeo anota su
 * resultado y el checklist se resuelve contra ella (y contra checkpoints/hops), en lugar de nacer siempre
 * PENDING. Lo que no tiene tool (p.ej. revision de modulos) queda PENDING para el humano.
 */
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { ChecklistFacts, ChecklistStatus } from './checklist.js';
import { loadCheckpoints } from './checkpoints.js';
import { loadHopProgress } from './hops.js';

export type EvidenceKey =
  | 'schema-pk'
  | 'cdc'
  | 'coherence'
  | 'verify'
  | 'backup-store'
  | 'estimate'
  | 'modules'
  | 'models';

export interface Evidence {
  project: string;
  key: EvidenceKey;
  status: ChecklistStatus;
  detail: string;
  at: string;
}

export const evidenceFile = (state: string): string => path.join(state, 'evidence.jsonl');

export async function recordEvidence(
  state: string,
  project: string,
  key: EvidenceKey,
  status: ChecklistStatus,
  detail: string,
): Promise<void> {
  try {
    await mkdir(state, { recursive: true });
    const entry: Evidence = { project, key, status, detail, at: new Date().toISOString() };
    await appendFile(evidenceFile(state), JSON.stringify(entry) + '\n', 'utf8');
  } catch {
    // La evidencia nunca debe romper la tool que la produce.
  }
}

/** Ultima evidencia por clave del proyecto. */
export async function latestEvidence(state: string, project: string): Promise<Map<EvidenceKey, Evidence>> {
  const latest = new Map<EvidenceKey, Evidence>();
  let text = '';
  try {
    text = await readFile(evidenceFile(state), 'utf8');
  } catch {
    return latest;
  }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as Evidence;
      if (entry.project === project) latest.set(entry.key, entry);
    } catch {
      // linea corrupta: se ignora
    }
  }
  return latest;
}

/** Hechos durables para resolver el checklist: evidencia + checkpoints OK + hops completados. */
export async function checklistFacts(
  state: string,
  project: string,
  hops: Array<{ to: string }>,
): Promise<ChecklistFacts> {
  const checkpoints = await loadCheckpoints(state, project);
  const stepsOk = new Set(
    checkpoints.filter((c) => c.status === 'OK' && !(c.detail ?? '').startsWith('dry-run')).map((c) => c.step),
  );
  const progress = await loadHopProgress(state, project);
  const last = hops.at(-1)?.to;
  const finalHop = last ? progress.filter((p) => p.to === last).at(-1) : undefined;
  // Ruta de un solo hop: no hay hops.jsonl; cuenta el smoke OK.
  const finalReached = hops.length <= 1 ? stepsOk.has('smoke-boot') : finalHop !== undefined;
  const finalAt = hops.length <= 1 ? checkpoints.filter((c) => c.step === 'smoke-boot' && c.status === 'OK').at(-1)?.at : finalHop?.at;
  return { evidence: await latestEvidence(state, project), stepsOk, finalReached, ...(finalAt ? { finalAt } : {}) };
}
