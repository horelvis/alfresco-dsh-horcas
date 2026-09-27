/**
 * Bloque GESTIONADO en la memoria global del arnes (`~/.dsh/AGENTS.md`): las ultimas LECCIONES
 * compartidas y los ultimos HITOS del journal, delimitados por marcadores. Asi el arnes los carga
 * NATIVAMENTE (paquete base `agent-instructions`, que lee AGENTS.md/CLAUDE.md) en cualquier
 * perfil/sesion, sin depender de la seccion de system prompt del plugin.
 *
 * Solo se toca el BLOQUE marcado: el resto del fichero (contenido manual del usuario) queda intacto.
 * Estado LOCAL; nunca toca el origen ni el destino.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadLessons, type Lesson } from './lessons.js';
import { loadJournal, MILESTONE_KINDS, type JournalEntry } from './journal.js';

export const AGENTS_BEGIN = '<!-- migrator:begin (gestionado; no editar a mano) -->';
export const AGENTS_END = '<!-- migrator:end -->';

/** Ruta del AGENTS.md global del arnes (override para tests: MIGRATOR_AGENTS_MD o DSH_HOME). */
export function agentsFile(env: NodeJS.ProcessEnv = process.env): string {
  if (env.MIGRATOR_AGENTS_MD) return env.MIGRATOR_AGENTS_MD;
  return path.join(env.DSH_HOME ?? path.join(os.homedir(), '.dsh'), 'AGENTS.md');
}

/** Bloque markdown con las ultimas N lecciones + hitos (los mas recientes primero). */
export function renderManagedBlock(lessons: Lesson[], milestones: JournalEntry[], limit = 10): string {
  const lines = [AGENTS_BEGIN, '', '## Migrador de Alfresco — memoria compartida', ''];
  if (lessons.length) {
    lines.push('### Lecciones aprendidas (compartidas entre proyectos)', '');
    for (const l of lessons.slice(-limit).reverse()) {
      lines.push(`- ${l.title}: ${l.detail}${l.tags?.length ? ` _(${l.tags.join(', ')})_` : ''}`);
    }
    lines.push('');
  }
  if (milestones.length) {
    lines.push('### Hitos recientes (journal)', '');
    for (const e of milestones.slice(-limit)) {
      lines.push(`- ${e.at} · ${e.project} · ${e.kind}: ${e.summary}`);
    }
    lines.push('');
  }
  lines.push(AGENTS_END);
  return lines.join('\n');
}

/** Inserta o reemplaza el bloque marcado en `content`, preservando el resto del fichero. */
export function upsertBlock(content: string, block: string): string {
  const start = content.indexOf(AGENTS_BEGIN);
  const end = content.indexOf(AGENTS_END);
  if (start !== -1 && end !== -1 && end > start) {
    return `${content.slice(0, start)}${block}${content.slice(end + AGENTS_END.length)}`;
  }
  const trimmed = content.replace(/\s*$/, '');
  return `${trimmed ? `${trimmed}\n\n` : ''}${block}\n`;
}

/**
 * Refresca el bloque gestionado en el AGENTS.md global. Si no hay lecciones ni hitos, no escribe
 * (no crea el fichero ni deja un bloque vacio).
 */
export async function syncAgentsMd(state: string, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const lessons = await loadLessons(env);
  const milestones = (await loadJournal(state)).filter((e) => MILESTONE_KINDS.has(e.kind));
  if (lessons.length === 0 && milestones.length === 0) return;
  const file = agentsFile(env);
  let current = '';
  try {
    current = await readFile(file, 'utf8');
  } catch {
    // fichero nuevo
  }
  const next = upsertBlock(current, renderManagedBlock(lessons, milestones));
  if (next !== current) {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, next, 'utf8');
  }
}
