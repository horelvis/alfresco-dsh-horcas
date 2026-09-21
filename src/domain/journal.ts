/**
 * JOURNAL de la migracion (`.migrator/journal.jsonl`): memoria DURABLE entre chats/sesiones del mismo
 * workspace. A diferencia de los checkpoints (solo intentos ejecutados) y los hops (solo completados),
 * aqui se anotan los HITOS de razonamiento: resumen del assessment, estrategia elegida, plan acordado,
 * decisiones, bloqueos y aprobaciones. Asi un chat nuevo puede "continuar" sin repetir todo.
 *
 * Solo escribe en el estado LOCAL (`.migrator`); nunca toca el origen ni el destino.
 */
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';

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

/** Ultima entrada del journal (por proyecto, y opcionalmente de un `kind` concreto). */
export async function latestJournal(state: string, project?: string, kind?: string): Promise<JournalEntry | undefined> {
  let latest: JournalEntry | undefined;
  for (const entry of await loadJournal(state, project)) {
    if (kind && entry.kind !== kind) continue;
    if (!latest || entry.at > latest.at) latest = entry;
  }
  return latest;
}
