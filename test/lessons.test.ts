import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { addLesson, lessonsTextSync, loadLessons, renderLessons } from '../src/domain/lessons.js';

describe('lecciones compartidas entre proyectos', () => {
  it('anota, lee y renderiza (fichero global via MIGRATOR_LESSONS)', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'les-'));
    const env = { MIGRATOR_LESSONS: path.join(dir, 'lessons.jsonl') };
    await addLesson({ title: 't1', detail: 'd1', tags: ['orden'] }, env);
    await addLesson({ title: 't2', detail: 'd2' }, env);
    const lessons = await loadLessons(env);
    expect(lessons).toHaveLength(2);
    expect(renderLessons(lessons)).toContain('[orden] t1: d1');
    expect(renderLessons(lessons)).toContain('[general] t2: d2');
    expect(lessonsTextSync(env)).toContain('t1');
    rmSync(dir, { recursive: true, force: true });
  });

  it('sin fichero devuelve vacio', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'les-'));
    expect(await loadLessons({ MIGRATOR_LESSONS: path.join(dir, 'nope.jsonl') })).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });
});
