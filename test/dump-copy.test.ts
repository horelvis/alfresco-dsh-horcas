import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { copyDumpToDestination } from '../src/domain/steps.js';

describe('copia del dump al destino', () => {
  it('conserva los bytes de un dump binario (no UTF-8) y verifica el tamaño', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'dump-'));
    const local = path.join(dir, 'db.dump');
    const remote = path.join(dir, 'dst', 'db', 'alfresco.dump');
    const binary = Buffer.from([0x50, 0x47, 0x44, 0x4d, 0x50, 0xff, 0xfe, 0x00, 0x80, 0xc3, 0x28, 0x0a]);
    await writeFile(local, binary);
    const result = await copyDumpToDestination({ name: 'local' }, local, remote);
    expect(result).toEqual({ ok: true, bytes: binary.length });
    expect(Buffer.compare(await readFile(remote), binary)).toBe(0);
  });

  it('falla (no OK) si no hay dump local', async () => {
    const result = await copyDumpToDestination({ name: 'local' }, '/no/existe.dump', '/tmp/x.dump');
    expect(result.ok).toBe(false);
  });
});
