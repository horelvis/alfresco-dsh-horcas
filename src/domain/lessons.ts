/**
 * LECCIONES APRENDIDAS: memoria COMPARTIDA entre workspaces/proyectos (a diferencia del journal, que es
 * por workspace). Cada migracion es distinta, pero hay fallos que se repiten (orden de pasos, permisos,
 * versiones...). Aqui se acumulan para que CUALQUIER proyecto/chat los tenga presentes.
 *
 * Almacen global: `MIGRATOR_LESSONS` o `~/.dsh/alfresco-migrator-lessons.jsonl`. Solo estado local.
 */
import { readFileSync } from 'node:fs';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export interface Lesson {
  at: string;
  title: string;
  detail: string;
  /** Etiquetas para filtrar (p.ej. orden, restore, reindex, permisos, version). */
  tags?: string[];
  /** Proyecto donde se aprendio (informativo). */
  project?: string;
}

export function lessonsFile(env: NodeJS.ProcessEnv = process.env): string {
  return env.MIGRATOR_LESSONS ?? path.join(os.homedir(), '.dsh', 'alfresco-migrator-lessons.jsonl');
}

export async function loadLessons(env: NodeJS.ProcessEnv = process.env): Promise<Lesson[]> {
  try {
    const text = await readFile(lessonsFile(env), 'utf8');
    return text
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as Lesson);
  } catch {
    return [];
  }
}

export async function addLesson(lesson: Omit<Lesson, 'at'> & { at?: string }, env: NodeJS.ProcessEnv = process.env): Promise<Lesson> {
  const full: Lesson = { at: lesson.at ?? new Date().toISOString(), title: lesson.title, detail: lesson.detail, ...(lesson.tags ? { tags: lesson.tags } : {}), ...(lesson.project ? { project: lesson.project } : {}) };
  const file = lessonsFile(env);
  await mkdir(path.dirname(file), { recursive: true });
  await appendFile(file, JSON.stringify(full) + '\n', 'utf8');
  return full;
}

/** Lista compacta (una linea por leccion, las ultimas primero) para el system prompt o una tool. */
export function renderLessons(lessons: Array<Pick<Lesson, 'title' | 'detail' | 'tags'>>, limit = 20): string {
  return lessons
    .slice(-limit)
    .reverse()
    .map((l) => `- [${(l.tags ?? []).join(',') || 'general'}] ${l.title}: ${l.detail}`)
    .join('\n');
}

/** Lectura SINCRONA (para la seccion de system prompt, que se evalua sin await). */
export function lessonsTextSync(env: NodeJS.ProcessEnv = process.env, limit = 20): string {
  try {
    const text = readFileSync(lessonsFile(env), 'utf8');
    const lessons = text
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as Lesson);
    return renderLessons(lessons, limit);
  } catch {
    return '';
  }
}
