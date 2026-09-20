/**
 * Backup no destructivo del origen (E17): verifica-o-crea el backup de BD y content store y guarda un
 * snapshot de la configuracion. El origen NUNCA se modifica (solo se lee). Portado de BackupService.
 *
 * La BD usa `MIGRATOR_DB_DUMP_CMD` ({out}) o, si no, se marca como gestionada externamente.
 * El store FS se copia con `rsync` (o `MIGRATOR_CONTENT_COPY_CMD`) y se genera un manifiesto SHA-256.
 */
import { mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { runShell, substitute, type ExecResult, type HostRef } from '../infra/exec.js';
import { sha256File, writeManifest, verifyManifest, readManifest, type ManifestDiff } from './manifest.js';
import { resolveContentStorePath } from './content-store.js';
import type { ProjectConfig } from './project-config.js';

export type BackupKind = 'DATABASE' | 'CONTENT_STORE' | 'CONFIG';

export interface BackupArtifact {
  kind: BackupKind;
  location: string;
  sizeBytes: number;
  sha256?: string;
  fileCount: number;
  preexisting: boolean;
  created: boolean;
  note?: string;
}

export interface BackupResult {
  project: string;
  backupDir: string;
  dryRun: boolean;
  artifacts: BackupArtifact[];
  originRetained: boolean;
  complete: boolean;
}

const planned = (kind: BackupKind, location: string, note: string): BackupArtifact => ({
  kind,
  location,
  sizeBytes: 0,
  fileCount: 0,
  preexisting: false,
  created: false,
  note,
});

async function nonEmptyFile(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isFile() && (await stat(file)).size > 0;
  } catch {
    return false;
  }
}

async function nonEmptyDir(dir: string): Promise<boolean> {
  try {
    return (await readdir(dir)).length > 0;
  } catch {
    return false;
  }
}

async function inventory(dir: string): Promise<{ files: number; bytes: number }> {
  let files = 0;
  let bytes = 0;
  async function walk(current: string): Promise<void> {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) {
        files++;
        bytes += (await stat(full)).size;
      }
    }
  }
  await walk(dir);
  return { files, bytes };
}

export interface BackupContext {
  project: ProjectConfig;
  backupDir: string;
  /** Host donde correr los comandos de backup: el ORIGEN (local por defecto), no el destino. */
  host: HostRef;
  dryRun: boolean;
  /** Entorno inyectable (por defecto process.env); facilita tests. */
  env?: NodeJS.ProcessEnv;
}

export async function runBackup(ctx: BackupContext): Promise<BackupResult> {
  const env = ctx.env ?? process.env;
  const artifacts: BackupArtifact[] = [];
  artifacts.push(await database(ctx, env));
  artifacts.push(await contentStore(ctx, env));
  artifacts.push(await config(ctx));
  const complete = artifacts.filter((a) => !a.note).length === 3;
  return {
    project: ctx.project.project,
    backupDir: ctx.backupDir,
    dryRun: ctx.dryRun,
    artifacts,
    originRetained: true,
    complete,
  };
}

async function database(ctx: BackupContext, env: NodeJS.ProcessEnv): Promise<BackupArtifact> {
  const dump = path.join(ctx.backupDir, 'db', 'alfresco-postgresql.dump');
  if (await nonEmptyFile(dump)) {
    return { kind: 'DATABASE', location: dump, sizeBytes: (await stat(dump)).size, sha256: await sha256File(dump), fileCount: 1, preexisting: true, created: false };
  }
  if (ctx.dryRun) return planned('DATABASE', dump, 'dump logico (D2) a crear');
  const override = env.MIGRATOR_DB_DUMP_CMD;
  if (!override) {
    return planned('DATABASE', dump, 'sin MIGRATOR_DB_DUMP_CMD: backup de BD gestionado externamente');
  }
  await mkdir(path.dirname(dump), { recursive: true });
  const result: ExecResult = await runShell(ctx.host, substitute(override, { out: dump }));
  if (result.exitCode !== 0 || !(await nonEmptyFile(dump))) {
    throw new Error(`Dump de BD fallido (exit=${result.exitCode}): ${result.stderr}`);
  }
  return { kind: 'DATABASE', location: dump, sizeBytes: (await stat(dump)).size, sha256: await sha256File(dump), fileCount: 1, preexisting: false, created: true };
}

async function contentStore(ctx: BackupContext, env: NodeJS.ProcessEnv): Promise<BackupArtifact> {
  const store = ctx.project.source.contentStore;
  const storePath = await resolveContentStorePath(store, ctx.host);
  if (!storePath) {
    return planned('CONTENT_STORE', '', 'el proyecto no define source.contentStore.path ni volume');
  }
  const dir = path.join(ctx.backupDir, 'contentstore');
  if (await nonEmptyDir(dir)) {
    return contentArtifact(dir, ctx, true, false, undefined);
  }
  if (ctx.dryRun) return planned('CONTENT_STORE', dir, 'copia del content store FS a crear');
  const override = env.MIGRATOR_CONTENT_COPY_CMD;
  const command = override
    ? substitute(override, { source: storePath, target: dir })
    : `rsync -a --info=stats2 "${storePath}/" "${dir}/"`;
  await mkdir(dir, { recursive: true });
  const result = await runShell(ctx.host, command);
  if (result.exitCode !== 0 || !(await nonEmptyDir(dir))) {
    throw new Error(`Copia del content store fallida (exit=${result.exitCode}): ${result.stderr}`);
  }
  return contentArtifact(dir, ctx, false, true, undefined);
}

async function contentArtifact(
  dir: string,
  ctx: BackupContext,
  preexisting: boolean,
  created: boolean,
  note: string | undefined,
): Promise<BackupArtifact> {
  const manifestFile = path.join(ctx.backupDir, 'contentstore-manifest.json');
  const { file } = await writeManifest(dir, manifestFile);
  const { files, bytes } = await inventory(dir);
  return {
    kind: 'CONTENT_STORE',
    location: dir,
    sizeBytes: bytes,
    sha256: await sha256File(file),
    fileCount: files,
    preexisting,
    created,
    note,
  };
}

async function config(ctx: BackupContext): Promise<BackupArtifact> {
  const file = path.join(ctx.backupDir, 'config', `${ctx.project.project}.json`);
  if (ctx.dryRun) return planned('CONFIG', file, 'snapshot de configuracion a escribir');
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(ctx.project.raw, null, 2), 'utf8');
  return { kind: 'CONFIG', location: file, sizeBytes: (await stat(file)).size, sha256: await sha256File(file), fileCount: 1, preexisting: false, created: true };
}

/** Verifica el content store de backup contra su manifiesto. */
export async function verifyBackupContent(backupDir: string, root: string): Promise<ManifestDiff> {
  const manifest = await readManifest(path.join(backupDir, 'contentstore-manifest.json'));
  return verifyManifest(root, manifest);
}
