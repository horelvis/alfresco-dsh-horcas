import { describe, expect, it } from 'vitest';
import { guardReason, shellMutationReason } from '../src/security/policy.js';

const ssh = (cmd: string) => `ssh -i ~/.ssh/k deploy@192.0.2.10 '${cmd}'`;

describe('guarda de shell: el destino y los stacks solo cambian via migrator', () => {
  it('bloquea mutaciones Docker (remotas y locales)', () => {
    expect(shellMutationReason(ssh('docker compose -f /x.yml up -d postgres'))).toMatch(/DESTINO/);
    expect(shellMutationReason(ssh('docker rm -f a'))).toBeDefined();
    expect(shellMutationReason('docker compose -p acme down')).toMatch(/ORIGEN/);
    expect(shellMutationReason(ssh('docker exec -i c psql -c "ALTER ROLE x"'))).toBeDefined();
  });

  it('bloquea cambios de ficheros por ssh', () => {
    expect(shellMutationReason(ssh('cp a b'))).toBeDefined();
    expect(shellMutationReason(ssh('echo x > /home/deploy/f'))).toBeDefined();
    expect(shellMutationReason('scp f deploy@h:/tmp/')).toBeDefined();
  });

  it('permite el diagnostico en solo lectura', () => {
    expect(shellMutationReason(ssh('docker ps -a; docker compose -f /x.yml logs --tail 50 alfresco 2>&1'))).toBeUndefined();
    expect(shellMutationReason(ssh('cat /home/deploy/x.properties; ls -la /d >/dev/null'))).toBeUndefined();
    expect(shellMutationReason('curl -s http://h:8080/alfresco/api/discovery')).toBeUndefined();
    expect(shellMutationReason('grep -rn foo src')).toBeUndefined();
  });

  it('se aplica a la tool bash via guardReason', () => {
    expect(guardReason({ name: 'bash', arguments: { command: ssh('docker compose up -d') } })).toBeDefined();
    expect(guardReason({ name: 'bash', arguments: { command: 'ls' } })).toBeUndefined();
  });
});

describe('autoproteccion: el agente no modifica el plugin ni el arnes', () => {
  it('bloquea compilar, copiar, editar o versionar en la carpeta del plugin/arnes', async () => {
    const { selfModificationReason, guardReason } = await import('../src/security/policy.js');
    expect(selfModificationReason('cd ~/git/dsh-alfresco-migrator && npm run build')).toMatch(/Autoproteccion/);
    expect(selfModificationReason('cp -r /srv/code/dsh-alfresco-migrator/dist /tmp/migrator-dist-prev')).toBeDefined();
    expect(selfModificationReason("sed -i 's/x/y/' /srv/code/dsh-alfresco-migrator/src/security/policy.ts")).toBeDefined();
    expect(selfModificationReason('git -C /srv/code/deepseek-harness commit -am x')).toBeDefined();
    expect(selfModificationReason('echo x > /srv/code/deepseek-harness/lib/a.js')).toBeDefined();
    expect(guardReason({ name: 'edit', arguments: { file_path: '/srv/code/dsh-alfresco-migrator/src/domain/models.ts' } })).toMatch(/Autoproteccion/);
    expect(guardReason({ name: 'write', arguments: { file_path: '/srv/ws/informe.md' } })).toBeUndefined();
  });

  it('no confunde palabras dentro de comillas (patron de grep) con escritura', async () => {
    const { selfModificationReason } = await import('../src/security/policy.js');
    expect(selfModificationReason('grep -rn "modelsJar\\|scp\\|rsync.*jar" ~/git/dsh-alfresco-migrator/src/domain/steps.ts')).toBeUndefined();
    expect(selfModificationReason('cd ~/git/dsh-alfresco-migrator && grep -rn "cp\\|mv\\|rm" src')).toBeUndefined();
    // Con comillas, una mutacion REAL sigue bloqueada: el verbo va FUERA de comillas.
    expect(selfModificationReason('rm "/srv/code/dsh-alfresco-migrator/src/a.ts"')).toBeDefined();
    expect(selfModificationReason('echo x > "/srv/code/deepseek-harness/lib/a.js"')).toBeDefined();
  });

  it('permite leer el plugin/arnes y trabajar en el workspace', async () => {
    const { selfModificationReason } = await import('../src/security/policy.js');
    expect(selfModificationReason('grep -rn validateModelsJar ~/git/dsh-alfresco-migrator/src')).toBeUndefined();
    expect(selfModificationReason('cat /srv/code/dsh-alfresco-migrator/src/domain/models.ts; git -C /srv/code/dsh-alfresco-migrator log -3')).toBeUndefined();
    expect(selfModificationReason('npm test')).toBeUndefined();
  });
});

describe('enforcer del rol auditor (solo lectura determinista)', () => {
  const agentWith = (text: string) => ({
    session: { surface: { nodes: [1] }, eventAt: () => ({ type: 'user/message', data: { content: [{ type: 'text', text }] } }) },
  });

  it('deniega escritura del migrator, edicion de ficheros y redireccion al auditor', () => {
    const agent = agentWith('[[MIGRATOR-AUDITOR]] revisa el ensayo');
    expect(guardReason({ name: 'migrator_run_steps', agent, arguments: {} })).toMatch(/Auditor en SOLO LECTURA/);
    expect(guardReason({ name: 'migrator_provision', agent, arguments: {} })).toMatch(/Auditor/);
    expect(guardReason({ name: 'write', agent, arguments: { file_path: '/tmp/x' } })).toMatch(/Auditor/);
    expect(guardReason({ name: 'bash', agent, arguments: { command: 'echo x > /tmp/y' } })).toMatch(/Auditor/);
    expect(guardReason({ name: 'bash', agent, arguments: { command: 'rm -rf .migrator' } })).toMatch(/Auditor/);
    expect(guardReason({ name: 'bash', agent, arguments: { command: "sed -i 's/FAIL/OK/' report.md" } })).toMatch(/Auditor/);
    expect(guardReason({ name: 'bash', agent, arguments: { command: 'grep -c "rm" .migrator/audit.jsonl 2>/dev/null' } })).toBeUndefined();
    // Lectura permitida.
    expect(guardReason({ name: 'migrator_audit', agent, arguments: {} })).toBeUndefined();
    expect(guardReason({ name: 'read', agent, arguments: {} })).toBeUndefined();
  });

  it('reconoce al teammate "auditor" de Agent Teams', () => {
    const agent = agentWith('You are teammate "auditor".\n\nrevisa el informe');
    expect(guardReason({ name: 'migrator_run_steps', agent, arguments: {} })).toMatch(/Auditor/);
  });

  it('un ejecutor normal NO se marca como auditor', () => {
    const agent = agentWith('inicia migracion');
    expect(guardReason({ name: 'migrator_run_steps', agent, arguments: {} })).toBeUndefined();
  });
});

describe('redireccion: no confundir => / -> / >= con escribir', () => {
  it('las consultas de lectura con funciones flecha no son escritura en el plugin', async () => {
    const { selfModificationReason, shellMutationReason } = await import('../src/security/policy.js');
    const read = `node -e 'const pg = require("/srv/code/dsh-alfresco-migrator/node_modules/pg"); (async () => { const r = await c.query("select 1"); r.rows.forEach((x) => console.log(x)); })()'`;
    expect(selfModificationReason(read)).toBeUndefined();
    expect(shellMutationReason("ssh h 'awk \"$1 >= 3\" /var/log/x'")).toBeUndefined();
    // una redireccion real sigue siendo escritura
    expect(selfModificationReason('echo x > /srv/code/dsh-alfresco-migrator/src/a.ts')).toBeDefined();
    expect(selfModificationReason('echo x >> /srv/code/dsh-alfresco-migrator/src/a.ts')).toBeDefined();
  });
});
