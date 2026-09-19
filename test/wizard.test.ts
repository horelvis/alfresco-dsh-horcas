import { describe, expect, it } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildProject, runWizard, validateProject } from '../src/domain/wizard.js';

describe('wizard', () => {
  it('genera un proyecto valido contra el JSON Schema', async () => {
    const root = await buildProject({ name: 'Demo Cliente', version: '7.1.0', edition: 'CE' });
    expect(root.project).toBe('demo-cliente');
    expect(await validateProject(root)).toEqual([]);
  });

  it('detecta schema invalido (campo requerido ausente)', async () => {
    expect((await validateProject({ project: 'x' })).length).toBeGreaterThan(0);
  });

  it('dry-run no escribe y previsualiza la ruta', async () => {
    const result = await runWizard({ inputs: { name: 'dry', version: '7.1.0', targetVersion: '26.2' }, dryRun: true });
    expect(result.errors).toEqual([]);
    expect(result.preview.hops.join(' ')).toContain('7.1.0->7.4');
    expect(result.preview.note).toContain('dry-run');
  });

  it('escribe el YAML en la ruta indicada', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'wiz-'));
    const out = path.join(dir, 'demo.yaml');
    const result = await runWizard({ inputs: { name: 'demo', version: '7.1.0' }, out, dryRun: false });
    expect(result.errors).toEqual([]);
    expect(result.preview.note).toContain('escrito');
    expect(result.yaml).toContain('project: demo');
  });

  it('acepta content store S3', async () => {
    const root = await buildProject({ name: 's3', storeType: 'S3', storePath: 'mybucket/alf' });
    expect(await validateProject(root)).toEqual([]);
    expect(JSON.stringify(root)).toContain('S3');
  });
});
