/**
 * Manifiesto de checksums SHA-256 del content store y verificacion de integridad.
 * Portado de ContentManifest/ContentManifestWriter/ContentManifestVerifier (E8/E10).
 * Rutas relativas a la raiz del store.
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

export interface ManifestEntry {
  path: string;
  sizeBytes: number;
  sha256: string;
}

export interface ContentManifest {
  algorithm: 'SHA-256';
  entries: ManifestEntry[];
}

export interface ManifestDiff {
  missing: string[];
  extra: string[];
  mismatched: string[];
  coherent: boolean;
  total: number;
}

export function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(file);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

async function walk(root: string, prefix: string, out: string[]): Promise<void> {
  const entries = await readdir(path.join(root, prefix), { withFileTypes: true });
  for (const entry of entries) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      await walk(root, relative, out);
    } else if (entry.isFile()) {
      out.push(relative);
    }
  }
}

/** Escanea un content store y genera su manifiesto (ordenado por ruta). */
export async function scanManifest(root: string): Promise<ContentManifest> {
  const files: string[] = [];
  await walk(root, '', files);
  files.sort();
  const entries: ManifestEntry[] = [];
  for (const relative of files) {
    const full = path.join(root, relative);
    entries.push({ path: relative, sizeBytes: (await stat(full)).size, sha256: await sha256File(full) });
  }
  return { algorithm: 'SHA-256', entries };
}

export async function writeManifest(root: string, manifestFile: string): Promise<{ manifest: ContentManifest; file: string }> {
  const manifest = await scanManifest(root);
  await mkdir(path.dirname(manifestFile), { recursive: true });
  await writeFile(manifestFile, JSON.stringify(manifest, null, 2), 'utf8');
  return { manifest, file: manifestFile };
}

export async function readManifest(file: string): Promise<ContentManifest> {
  return JSON.parse(await readFile(file, 'utf8')) as ContentManifest;
}

/** Verifica un content store contra su manifiesto: faltantes, sobrantes y checksums distintos. */
export async function verifyManifest(root: string, expected: ContentManifest): Promise<ManifestDiff> {
  const actual = await scanManifest(root);
  const actualByPath = new Map(actual.entries.map((e) => [e.path, e]));
  const expectedByPath = new Map(expected.entries.map((e) => [e.path, e]));

  const missing: string[] = [];
  const mismatched: string[] = [];
  for (const [p, entry] of expectedByPath) {
    const found = actualByPath.get(p);
    if (!found) missing.push(p);
    else if (found.sizeBytes !== entry.sizeBytes || found.sha256 !== entry.sha256) mismatched.push(p);
  }
  const extra = [...actualByPath.keys()].filter((p) => !expectedByPath.has(p));
  return {
    missing,
    extra,
    mismatched,
    coherent: missing.length === 0 && extra.length === 0 && mismatched.length === 0,
    total: missing.length + extra.length + mismatched.length,
  };
}
