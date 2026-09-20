import { describe, expect, it } from 'vitest';
import { loadProject, parseProjectYaml } from '../src/domain/project-config.js';

describe('loadProject', () => {
  it('error claro (con sugerencia) si el proyecto no existe', async () => {
    await expect(loadProject('no/existe/foo.yaml')).rejects.toThrow(
      /Proyecto no encontrado:.*migrator_wizard/,
    );
  });

  it('carga un proyecto existente', async () => {
    const project = await loadProject('data/projects/example.yaml');
    expect(project.project).toBe('gadex-7.1.0');
    expect(project.source.version).toBe('7.1.0');
  });

  it('parsea stage y contentStore.volume', () => {
    const project = parseProjectYaml(
      'project: demo\nstage: clone\nsource:\n  version: "7.1.0"\ntarget:\n  version: "26.2"\n  contentStore: { type: FS, volume: v, path: contentstore }\n',
    );
    expect(project.stage).toBe('clone');
    expect(project.target.contentStore?.volume).toBe('v');
  });
});
