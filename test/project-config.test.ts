import { describe, expect, it } from 'vitest';
import { loadProject, parseProjectYaml, projectCandidates } from '../src/domain/project-config.js';

describe('loadProject', () => {
  it('error claro (con sugerencia) si el proyecto no existe', async () => {
    await expect(loadProject('no/existe/foo.yaml')).rejects.toThrow(
      /Proyecto no encontrado.*migrator_wizard/,
    );
  });

  it('resuelve un nombre de proyecto a <nombre>.yaml (workspace y data/projects)', () => {
    const candidates = projectCandidates('gadex-7.1.0', '/ws', '/data');
    expect(candidates).toContain('/ws/gadex-7.1.0.yaml');
    expect(candidates).toContain('/data/gadex-7.1.0.yaml');
    // una ruta relativa tambien se prueba bajo el directorio de datos del plugin
    expect(projectCandidates('data/projects/example.yaml', '/ws', '/data')).toContain(
      '/data/data/projects/example.yaml',
    );
    // una ruta absoluta no se reescribe
    expect(projectCandidates('/abs/p.yaml', '/ws', '/data')).toEqual(['/abs/p.yaml']);
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

  it('parsea target.composeFile (compose validado EN EL DESTINO)', () => {
    const project = parseProjectYaml(
      'project: demo\nsource:\n  version: "7.1.0"\ntarget:\n  version: "26.2"\n  composeFile: /home/op/infra/alfresco/docker-compose.yml\n',
    );
    expect(project.target.composeFile).toBe('/home/op/infra/alfresco/docker-compose.yml');
  });
});
