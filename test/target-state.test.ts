import { describe, expect, it } from 'vitest';
import { parseTargetState, targetStateCommand } from '../src/domain/target-state.js';
import { shellMutationReason } from '../src/security/policy.js';

describe('estado real del destino (solo lectura)', () => {
  it('parsea contenedores, directorio, composes, modelos, content store y pg-data', () => {
    const out = ['@@containers', 'p-alfresco-1|Up 3 minutes|alfresco/x:26.2.0', 'p-postgres-1|Exited (0)|postgres:15',
      '@@datadir', 'yes', '@@composes', 'docker-compose-7.4.yml', '@@models', 'p-models.jar', '@@volume', 'alf=4769', 'pg=19'].join('\n');
    const s = parseTargetState(out, '/d');
    expect(s.containers).toHaveLength(2);
    expect(s).toMatchObject({ dataDirExists: true, composes: ['docker-compose-7.4.yml'], modelsJar: true, alfDataFiles: 4769, pgData: 'present' });
  });

  it('destino vacio: sin contenedores, sin directorio, pg-data desconocido', () => {
    const s = parseTargetState('@@containers\n@@datadir\nno\n@@composes\n@@models\n@@volume\n', '/d');
    expect(s).toMatchObject({ containers: [], dataDirExists: false, modelsJar: false, pgData: 'unknown' });
  });

  it('monta los datos SOLO LECTURA y filtra por el proyecto', () => {
    const cmd = targetStateCommand('p', '/d');
    expect(cmd).toContain('-v "/d:/mnt:ro"');
    expect(cmd).toContain('label=com.docker.compose.project=p');
    // Es la tool del plugin (no la shell del agente) quien lo ejecuta: la guarda de shell lo bloquearia.
    expect(shellMutationReason(`ssh h '${cmd}'`)).toBeDefined();
  });
});
