/**
 * Verificacion de PARIDAD origen -> destino tras la migracion (read-only).
 *
 * Hechos, no juicio: compara recuentos de la BD (nodos y referencias de contenido) y el content store
 * (ficheros/bytes) entre origen y destino, y emite un veredicto determinista. Los recuentos se inyectan
 * (probes) para poder testear sin entorno; los helpers de IO solo traducen a hechos.
 *
 * No se cubre ACL (requiere comparacion por nodo, no un recuento): queda como comprobacion manual.
 */
import type { HostRef } from '../infra/exec.js';
import { runShell } from '../infra/exec.js';
import { connectSource, dbConfigFromYaml, queryRows, sourceDbConfigFromEnv, targetDbConfigFromEnv, type SourceDbConfig } from '../infra/pg.js';
import { describeError } from '../infra/errors.js';
import { scanStore } from './assessment.js';
import type { ProjectConfig } from './project-config.js';

export interface CountCheck {
  label: string;
  source: number;
  target: number;
  delta: number;
  tolerancePct: number;
  ok: boolean;
}

export interface StoreCheck {
  label: string;
  source: number;
  target: number;
  delta: number;
  tolerancePct: number;
  ok: boolean;
}

export interface StoreInventory {
  files: number;
  bytes: number;
}

export type VerificationVerdict = 'PASS' | 'WARN' | 'FAIL';

export interface VerificationReport {
  project: string;
  counts: CountCheck[];
  store: StoreCheck[];
  verdict: VerificationVerdict;
  notes: string[];
}

export interface ParityProbes {
  sourceCounts(): Promise<Record<string, number>>;
  targetCounts(): Promise<Record<string, number>>;
  sourceStore(): Promise<StoreInventory | undefined>;
  targetStore(): Promise<StoreInventory | undefined>;
}

function withinTolerance(source: number, target: number, tolerancePct: number): { delta: number; ok: boolean } {
  const delta = target - source;
  if (source === 0) return { delta, ok: target === 0 };
  const pct = (Math.abs(delta) / source) * 100;
  return { delta, ok: pct <= tolerancePct };
}

export function countCheck(label: string, source: number, target: number, tolerancePct = 0): CountCheck {
  const { delta, ok } = withinTolerance(source, target, tolerancePct);
  return { label, source, target, delta, tolerancePct, ok };
}

export function storeCheck(label: string, source: number, target: number, tolerancePct = 0): StoreCheck {
  const { delta, ok } = withinTolerance(source, target, tolerancePct);
  return { label, source, target, delta, tolerancePct, ok };
}

/** FAIL si alguna metrica discrepa; WARN si todo cuadra pero hay algo no verificable; PASS si todo cuadra. */
export function verdictOf(counts: CountCheck[], store: StoreCheck[], notes: string[]): VerificationVerdict {
  if (counts.some((c) => !c.ok) || store.some((s) => !s.ok)) return 'FAIL';
  return notes.length > 0 ? 'WARN' : 'PASS';
}

export async function verifyParity(
  project: ProjectConfig,
  probes: ParityProbes,
  tolerancePct = 0,
): Promise<VerificationReport> {
  const notes: string[] = [];
  // allSettled: una BD inaccesible no debe tumbar la verificacion entera (ni lanzar un AggregateError vacio).
  const [sourceResult, targetResult] = await Promise.allSettled([probes.sourceCounts(), probes.targetCounts()]);
  const sourceCounts = sourceResult.status === 'fulfilled' ? sourceResult.value : {};
  const targetCounts = targetResult.status === 'fulfilled' ? targetResult.value : {};
  if (sourceResult.status === 'rejected') notes.push(`conteos del ORIGEN no disponibles: ${describeError(sourceResult.reason)}`);
  if (targetResult.status === 'rejected') notes.push(`conteos del DESTINO no disponibles: ${describeError(targetResult.reason)}`);
  const labels = [...new Set([...Object.keys(sourceCounts), ...Object.keys(targetCounts)])].sort();
  const counts = labels.map((label) => countCheck(label, sourceCounts[label] ?? 0, targetCounts[label] ?? 0, tolerancePct));

  let store: StoreCheck[] = [];
  try {
    const [source, target] = await Promise.all([probes.sourceStore(), probes.targetStore()]);
    if (source && target) {
      store = [
        storeCheck('contentstore.files', source.files, target.files, tolerancePct),
        storeCheck('contentstore.bytes', source.bytes, target.bytes, tolerancePct),
      ];
    } else {
      notes.push('content store no verificable (ruta no accesible en origen o destino)');
    }
  } catch (error) {
    notes.push(`content store no verificable: ${describeError(error)}`);
  }

  return { project: project.project, counts, store, verdict: verdictOf(counts, store, notes), notes };
}

/** Metricas de recuento comparadas entre origen y destino. */
export const PARITY_COUNT_SQL: Record<string, string> = {
  nodes: 'SELECT COUNT(*) AS n FROM alf_node',
  contentRefs: 'SELECT COUNT(*) AS n FROM alf_content_url',
};

export async function dbCounts(config: SourceDbConfig): Promise<Record<string, number>> {
  const client = await connectSource(config);
  try {
    const result: Record<string, number> = {};
    for (const [label, sql] of Object.entries(PARITY_COUNT_SQL)) {
      result[label] = Number((await queryRows(client, sql))[0]?.n ?? 0);
    }
    return result;
  } finally {
    await client.end();
  }
}

export const sourceCounts = (): Promise<Record<string, number>> => dbCounts(sourceDbConfigFromEnv());
export const targetCounts = (): Promise<Record<string, number>> => dbCounts(targetDbConfigFromEnv());

/** Recuentos usando los HECHOS del proyecto (YAML): el host del destino sale del YAML, no de `localhost`. */
export const sourceCountsFor = (project: ProjectConfig): Promise<Record<string, number>> =>
  dbCounts(dbConfigFromYaml(project.source.database, 'SRC'));
export const targetCountsFor = (project: ProjectConfig): Promise<Record<string, number>> =>
  dbCounts(dbConfigFromYaml(project.target.database, 'DST'));

/** Inventario de un content store FS local; `undefined` si no es FS o no hay ruta. */
export async function localStoreInventory(store?: { type?: string; path?: string }): Promise<StoreInventory | undefined> {
  if (!store?.path || (store.type ?? 'FS').toUpperCase() !== 'FS') return undefined;
  const scan = await scanStore(store.path);
  return { files: scan.files, bytes: scan.bytes };
}

/** Inventario de un content store remoto via SSH (`find` + `du`); `undefined` si no es medible. */
export async function remoteStoreInventory(host: HostRef, path: string): Promise<StoreInventory | undefined> {
  if (!path) return undefined;
  const command = `find "${path}" -type f 2>/dev/null | wc -l; du -sk "${path}" 2>/dev/null | awk '{print $1}'`;
  const result = await runShell(host, command);
  if (result.exitCode !== 0) return undefined;
  const values = result.stdout
    .trim()
    .split(/\s+/)
    .map((value) => Number.parseInt(value, 10));
  const files = values[0];
  const kb = values[1];
  if (files === undefined || kb === undefined || !Number.isFinite(files) || !Number.isFinite(kb)) return undefined;
  return { files, bytes: kb * 1024 };
}
