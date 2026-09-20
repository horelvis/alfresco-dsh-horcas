import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { scanManifest, writeManifest, verifyManifest } from '../src/domain/manifest.js';
import { runBackup } from '../src/domain/backup.js';
import type { ProjectConfig } from '../src/domain/project-config.js';

async function tempStore(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'store-'));
  await mkdir(path.join(root, '2025', '9', '23'), { recursive: true });
  await writeFile(path.join(root, '2025', '9', '23', 'a.bin'), 'hola');
  await writeFile(path.join(root, '2025', '9', '23', 'b.bin'), 'mundo');
  return root;
}

function project(storePath: string): ProjectConfig {
  return {
    project: 'demo',
    stage: 'test',
    access: { mode: 'local', hosts: {} },
    source: { version: '7.1.0', contentStore: { type: 'FS', path: storePath } },
    target: { version: '26.2' },
    migration: {},
    raw: { project: 'demo' },
  };
}

describe('manifest', () => {
  it('escanea y calcula sha256 estable', async () => {
    const root = await tempStore();
    const manifest = await scanManifest(root);
    expect(manifest.algorithm).toBe('SHA-256');
    expect(manifest.entries.map((e) => e.path)).toEqual(['2025/9/23/a.bin', '2025/9/23/b.bin']);
    expect(manifest.entries[0]?.sha256).toMatch(/^[0-9a-f]{64}$/);
    await rm(root, { recursive: true, force: true });
  });

  it('verifica: coherente, y detecta missing/extra/mismatched', async () => {
    const root = await tempStore();
    const manifest = await scanManifest(root);
    expect((await verifyManifest(root, manifest)).coherent).toBe(true);

    await writeFile(path.join(root, '2025', '9', '23', 'a.bin'), 'CAMBIADO');
    await writeFile(path.join(root, '2025', '9', '23', 'c.bin'), 'nuevo');
    const diff = await verifyManifest(root, manifest);
    expect(diff.mismatched).toContain('2025/9/23/a.bin');
    expect(diff.extra).toContain('2025/9/23/c.bin');
    expect(diff.coherent).toBe(false);
    await rm(root, { recursive: true, force: true });
  });

  it('detecta faltantes', async () => {
    const root = await tempStore();
    const manifest = await scanManifest(root);
    await rm(path.join(root, '2025', '9', '23', 'b.bin'));
    expect((await verifyManifest(root, manifest)).missing).toContain('2025/9/23/b.bin');
    await rm(root, { recursive: true, force: true });
  });
});

describe('backup', () => {
  it('dry-run planifica sin escribir', async () => {
    const store = await tempStore();
    const backupDir = await mkdtemp(path.join(os.tmpdir(), 'bk-'));
    const result = await runBackup({ project: project(store), backupDir, host: { name: 'local' }, dryRun: true, env: {} });
    expect(result.originRetained).toBe(true);
    expect(result.artifacts.find((a) => a.kind === 'CONTENT_STORE')?.note).toBeTruthy();
    await rm(store, { recursive: true, force: true });
    await rm(backupDir, { recursive: true, force: true });
  });

  it('dry-run detecta un backup ya existente (preexisting) y lo marca completo', async () => {
    const store = await tempStore();
    const backupDir = await mkdtemp(path.join(os.tmpdir(), 'bk-'));
    await mkdir(path.join(backupDir, 'db'), { recursive: true });
    await writeFile(path.join(backupDir, 'db', 'alfresco-postgresql.dump'), 'dump');
    await mkdir(path.join(backupDir, 'contentstore', '2025'), { recursive: true });
    await writeFile(path.join(backupDir, 'contentstore', '2025', 'x.bin'), 'x');
    await mkdir(path.join(backupDir, 'config'), { recursive: true });
    await writeFile(path.join(backupDir, 'config', 'demo.json'), '{}');

    const result = await runBackup({ project: project(store), backupDir, host: { name: 'local' }, dryRun: true, env: {} });
    expect(result.artifacts.every((a) => a.preexisting)).toBe(true);
    expect(result.complete).toBe(true);
    await rm(store, { recursive: true, force: true });
    await rm(backupDir, { recursive: true, force: true });
  });

  it('copia el store con rsync y genera manifiesto + snapshot de config', async () => {
    const store = await tempStore();
    const backupDir = await mkdtemp(path.join(os.tmpdir(), 'bk-'));
    const result = await runBackup({ project: project(store), backupDir, host: { name: 'local' }, dryRun: false, env: {} });

    const content = result.artifacts.find((a) => a.kind === 'CONTENT_STORE');
    expect(content?.fileCount).toBe(2);
    expect(content?.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(result.artifacts.find((a) => a.kind === 'CONFIG')?.created).toBe(true);
    // La BD sin MIGRATOR_DB_DUMP_CMD queda como gestionada externamente.
    expect(result.artifacts.find((a) => a.kind === 'DATABASE')?.note).toBeTruthy();

    const manifest = await scanManifest(path.join(backupDir, 'contentstore'));
    expect(manifest.entries).toHaveLength(2);
    await rm(store, { recursive: true, force: true });
    await rm(backupDir, { recursive: true, force: true });
  });
});
