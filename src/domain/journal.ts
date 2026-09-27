/**
 * JOURNAL de la migracion (`.migrator/journal.jsonl`): memoria DURABLE entre chats/sesiones del mismo
 * workspace. A diferencia de los checkpoints (solo intentos ejecutados) y los hops (solo completados),
 * aqui se anotan los HITOS de razonamiento: resumen del assessment, estrategia elegida, plan acordado,
 * decisiones, bloqueos y aprobaciones. Asi un chat nuevo puede "continuar" sin repetir todo.
 *
 * Solo escribe en el estado LOCAL (`.migrator`); nunca toca el origen ni el destino.
 */
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/** Tipos de hito que cuentan como "hito" para la memoria (los de razonamiento/estado, no notas sueltas). */
export const MILESTONE_KINDS = new Set(['assessment', 'strategy', 'plan', 'decision', 'blocker', 'approval']);

export interface JournalEntry {
  at: string;
  project: string;
  /** Tipo de hito: assessment | strategy | plan | decision | blocker | approval | note | ... */
  kind: string;
  summary: string;
  /** Datos libres del hito (no interpretados por el codigo). */
  data?: Record<string, unknown>;
}

export function journalFile(state: string): string {
  return path.join(state, 'journal.jsonl');
}

export async function appendJournal(state: string, entry: Omit<JournalEntry, 'at'> & { at?: string }): Promise<JournalEntry> {
  const full: JournalEntry = { at: entry.at ?? new Date().toISOString(), project: entry.project, kind: entry.kind, summary: entry.summary, ...(entry.data ? { data: entry.data } : {}) };
  await mkdir(state, { recursive: true });
  await appendFile(journalFile(state), JSON.stringify(full) + '\n', 'utf8');
  return full;
}

export async function loadJournal(state: string, project?: string): Promise<JournalEntry[]> {
  let text: string;
  try {
    text = await readFile(journalFile(state), 'utf8');
  } catch {
    return [];
  }
  return text
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as JournalEntry)
    .filter((e) => !project || e.project === project);
}

/**
 * Lectura SINCRONA de los ultimos hitos (para la seccion de system prompt, que se evalua sin await).
 * Formato de una linea por hito, del mas reciente al mas antiguo.
 */
export function journalTextSync(state: string, project?: string, limit = 12): string {
  try {
    const text = readFileSync(journalFile(state), 'utf8');
    const entries = text
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as JournalEntry)
      .filter((e) => MILESTONE_KINDS.has(e.kind) && (!project || e.project === project));
    return entries
      .slice(-limit)
      .reverse()
      .map((e) => `- ${e.at} [${e.kind}] ${e.summary}`)
      .join('\n');
  } catch {
    return '';
  }
}

/** Ultima entrada del journal (por proyecto, y opcionalmente de un `kind` concreto). */
export async function latestJournal(state: string, project?: string, kind?: string): Promise<JournalEntry | undefined> {
  let latest: JournalEntry | undefined;
  for (const entry of await loadJournal(state, project)) {
    if (kind && entry.kind !== kind) continue;
    if (!latest || entry.at > latest.at) latest = entry;
  }
  return latest;
}
