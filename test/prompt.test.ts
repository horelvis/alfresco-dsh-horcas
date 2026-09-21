import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { conductSectionText, projectContextText } from '../src/prompt.js';

describe('conducta operativa (system prompt)', () => {
  it('pide no narrar pasos intermedios y entregar un unico resumen final', () => {
    const text = conductSectionText();
    expect(text).toMatch(/no narres pasos intermedios/i);
    expect(text).toMatch(/unico resumen final/i);
    expect(text).toMatch(/ask_user_question/);
  });

  it('mapea entradas minimas ("iniciar/continuar migracion") al playbook', () => {
    const text = conductSectionText();
    expect(text).toMatch(/iniciar migracion/i);
    expect(text).toContain('alfresco-migration-playbook');
  });
});

describe('contexto del proyecto (stage)', () => {
  it('deja explicito que es ENSAYO cuando stage=test', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'ctx-'));
    writeFileSync(path.join(dir, 'p.yaml'), 'project: demo\nstage: test\nsource: { version: "7.1.0" }\ntarget: { version: "7.4" }\n');
    const text = projectContextText(dir, {});
    expect(text).toContain('stage=test');
    expect(text).toMatch(/ENSAYO: NO es PROD/);
    expect(text).toContain('7.1.0 -> 7.4');
    rmSync(dir, { recursive: true, force: true });
  });

  it('marca PRODUCCION cuando stage=prod, y vacio si no hay proyecto', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'ctx-'));
    writeFileSync(path.join(dir, 'p.yaml'), 'project: demo\nstage: prod\nsource: { version: "7.1.0" }\ntarget: { version: "26.2" }\n');
    expect(projectContextText(dir, {})).toMatch(/PRODUCCION/);
    const empty = mkdtempSync(path.join(os.tmpdir(), 'ctx-'));
    expect(projectContextText(empty, {})).toBe('');
    rmSync(dir, { recursive: true, force: true });
    rmSync(empty, { recursive: true, force: true });
  });
});
