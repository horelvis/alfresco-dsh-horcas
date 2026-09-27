import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AGENTS_BEGIN, AGENTS_END, agentsFile, syncAgentsMd, upsertBlock } from '../src/domain/agents-md.js';
import { journalTextSync, appendJournal } from '../src/domain/journal.js';
import { addLesson } from '../src/domain/lessons.js';

const block = (body: string): string => [AGENTS_BEGIN, body, AGENTS_END].join('\n');

describe('bloque gestionado en ~/.dsh/AGENTS.md', () => {
  it('inserta el bloque preservando el contenido manual y lo reemplaza (sin duplicar)', () => {
    const manual = '# Mis notas\n\ncontenido manual\n';
    const once = upsertBlock(manual, block('bloque v1'));
    expect(once).toContain('# Mis notas');
    expect(once).toContain('bloque v1');
    const twice = upsertBlock(once, block('bloque v2'));
    expect(twice.match(/migrator:begin/g)?.length).toBe(1);
    expect(twice).toContain('bloque v2');
    expect(twice).not.toContain('bloque v1');
  });

  it('syncAgentsMd escribe lecciones + hitos (no las notas) y es idempotente', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'dshhome-'));
    const state = await mkdtemp(path.join(os.tmpdir(), 'state-'));
    const env = { ...process.env, DSH_HOME: home, MIGRATOR_LESSONS: path.join(home, 'lessons.jsonl') };
    const agents = agentsFile(env);
    await writeFile(agents, '# Manual\n');
    await addLesson({ title: 'L1', detail: 'detalle 1', tags: ['compose'] }, env);
    await appendJournal(state, { project: 'p', kind: 'decision', summary: 'hito decision' });
    await appendJournal(state, { project: 'p', kind: 'note', summary: 'nota suelta' });

    await syncAgentsMd(state, env);
    await syncAgentsMd(state, env);

    const text = await readFile(agents, 'utf8');
    expect(text).toContain('# Manual');
    expect(text).toContain('L1');
    expect(text).toContain('hito decision');
    expect(text).not.toContain('nota suelta');
    expect(text.match(/migrator:begin/g)?.length).toBe(1);
  });

  it('journalTextSync devuelve solo hitos, del mas reciente al mas antiguo', async () => {
    const state = await mkdtemp(path.join(os.tmpdir(), 'state-'));
    await appendJournal(state, { project: 'p', kind: 'note', summary: 'ruido' });
    await appendJournal(state, { project: 'p', kind: 'blocker', summary: 'bloqueo 1', at: '2026-01-01T00:00:00Z' });
    const out = journalTextSync(state);
    expect(out).toContain('bloqueo 1');
    expect(out).not.toContain('ruido');
  });
});
