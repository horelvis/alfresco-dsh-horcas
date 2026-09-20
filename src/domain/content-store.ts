/**
 * Resolucion del content store en un host: puede ser una **ruta del host** (`path`) o un **volumen
 * Docker** (`volume`). Un volumen Docker se mapea a una ruta real en el host; se obtiene con
 * `docker volume inspect -f '{{.Mountpoint}}'` (nada de copiar dentro del contenedor).
 */
import { runShell, type HostRef } from '../infra/exec.js';

export interface ContentStoreLocation {
  type?: string;
  path?: string;
  bucket?: string;
  volume?: string;
}

/** Ruta absoluta del store a partir del mountpoint del volumen y un subpath relativo opcional. */
export function storePathFromMountpoint(mountpoint: string, subpath?: string): string {
  const root = mountpoint.replace(/\/+$/, '');
  if (!subpath) return root;
  return `${root}/${subpath.replace(/^\/+/, '')}`;
}

/** Mountpoint real de un volumen Docker en el host (`docker volume inspect`). */
export async function dockerVolumeMountpoint(host: HostRef, volume: string): Promise<string | undefined> {
  const result = await runShell(host, `docker volume inspect -f '{{.Mountpoint}}' ${volume}`);
  const mountpoint = result.stdout.trim();
  return result.exitCode === 0 && mountpoint ? mountpoint : undefined;
}

/**
 * Resuelve la ruta del content store en `host`: si declara `volume`, obtiene su mountpoint real (y,
 * si hay `path`, lo trata como subruta relativa dentro del volumen); si no, devuelve `path`.
 */
export async function resolveContentStorePath(
  store: ContentStoreLocation | undefined,
  host: HostRef,
): Promise<string | undefined> {
  if (!store) return undefined;
  if (store.volume) {
    const mountpoint = await dockerVolumeMountpoint(host, store.volume);
    return mountpoint ? storePathFromMountpoint(mountpoint, store.path) : undefined;
  }
  return store.path;
}
