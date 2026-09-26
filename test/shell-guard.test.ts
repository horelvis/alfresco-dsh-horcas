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
