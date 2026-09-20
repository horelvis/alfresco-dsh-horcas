/**
 * Guarda de HOPS: garantiza que una ruta de upgrade multi-hop se ejecuta en orden y con el DESTINO
 * en la version del hop que toca. No depende del criterio del agente ni del operador:
 * - la version del DESTINO se LEE del propio repositorio (Discovery REST), no se declara;
 * - si no se puede verificar, se falla en cerrado (deny);
 * - el progreso se registra durablemente en `.migrator/hops.jsonl`.
 *
 * Para una ruta de un solo hop no aplica (no hay cadena que respetar).
 */
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseVersion, compareTuple } from './versions.js';
import type { Hop } from './upgrade-paths.js';
import type { ProjectConfig } from './project-config.js';
import { discoverRest } from './assessment.js';

export interface HopProgress {
  project: string;
  from: string;
  to: string;
  at: string;
}

export function hopsFile(state: string): string {
  return path.join(state, 'hops.jsonl');
}

export async function loadHopProgress(state: string, project: string): Promise<HopProgress[]> {
  try {
    const text = await readFile(hopsFile(state), 'utf8');
    return text
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as HopProgress)
      .filter((entry) => entry.project === project);
  } catch {
    return [];
  }
}

export async function recordHop(state: string, project: string, hop: { from: string; to: string }): Promise<void> {
  await mkdir(state, { recursive: true });
  const entry: HopProgress = { project, from: hop.from, to: hop.to, at: new Date().toISOString() };
  await appendFile(hopsFile(state), JSON.stringify(entry) + '\n', 'utf8');
}

/** Primer hop pendiente (por `to`); `undefined` si todos completados. */
export function nextHop(hops: Hop[], completed: Set<string>): Hop | undefined {
  return hops.find((hop) => !completed.has(hop.to));
}

/** Compara version por mayor.minor (7.4 == 7.4.0). */
export function sameMinor(a: string, b: string): boolean {
  const pa = parseVersion(a).slice(0, 2);
  const pb = parseVersion(b).slice(0, 2);
  return compareTuple(pa, pb) === 0;
}

export interface HopAlignment {
  ok: boolean;
  expected: string;
  actual?: string;
  reason?: string;
}

/**
 * Comprueba que la version del DESTINO casa con el hop que toca:
 * - si quedan hops, el destino debe estar en `nextHop.to`;
 * - si no quedan, en la version final (target);
 * - sin version del destino => no verificable => falla (fail-closed).
 */
export function checkHopAlignment(
  hops: Hop[],
  completed: Set<string>,
  destinationVersion: string | undefined,
  finalVersion: string,
): HopAlignment {
  if (hops.length <= 1) return { ok: true, expected: finalVersion };
  const pending = nextHop(hops, completed);
  const expected = pending ? pending.to : finalVersion;
  if (!destinationVersion) {
    return { ok: false, expected, reason: 'no se pudo determinar la version del DESTINO (define MIGRATOR_DST_BASE_URL)' };
  }
  if (!sameMinor(destinationVersion, expected)) {
    return {
      ok: false,
      expected,
      actual: destinationVersion,
      reason: `el DESTINO esta en ${destinationVersion} y el siguiente hop exige ${expected}`,
    };
  }
  return { ok: true, expected, actual: destinationVersion };
}

/**
 * Guarda que se aplica antes de escribir en el DESTINO de una ruta multi-hop. Lanza si el destino no
 * esta en la version del hop que toca o si no se puede verificar.
 */
export async function assertDestinationHop(project: ProjectConfig, state: string, hops: Hop[]): Promise<void> {
  if (hops.length <= 1) return;
  const baseUrl = project.target.baseUrl ?? process.env.MIGRATOR_DST_BASE_URL;
  const detected = baseUrl
    ? await discoverRest(
        baseUrl,
        process.env.MIGRATOR_DST_USER ?? process.env.MIGRATOR_SRC_USER,
        process.env.MIGRATOR_DST_PASSWORD ?? process.env.MIGRATOR_SRC_PASSWORD,
      )
    : undefined;
  const progress = await loadHopProgress(state, project.project);
  const alignment = checkHopAlignment(
    hops,
    new Set(progress.map((p) => p.to)),
    detected?.version,
    project.target.version,
  );
  if (!alignment.ok) {
    throw new Error(`Guarda de hops: ${alignment.reason}. Ruta: ${hops.map((h) => `${h.from}->${h.to}`).join(' -> ')}`);
  }
}

/** Registra el hop pendiente como completado tras un schema-upgrade correcto. */
export async function recordCompletedHop(state: string, project: ProjectConfig, hops: Hop[]): Promise<void> {
  if (hops.length <= 1) return;
  const progress = await loadHopProgress(state, project.project);
  const pending = nextHop(hops, new Set(progress.map((p) => p.to)));
  if (pending) await recordHop(state, project.project, pending);
}
