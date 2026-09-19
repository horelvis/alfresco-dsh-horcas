/**
 * Evaluador de la MATRIZ de rutas de upgrade (datos en `data/upgrade-paths.yaml`).
 *
 * Aqui solo hay ARITMETICA de aplicacion de reglas: no hay conocimiento hardcodeado (versiones,
 * notas ni textos viven en el YAML). El fabricante cambia la matriz -> se edita el YAML.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { dataDir } from './data-dir.js';
import { atLeast, compareVersions, parseVersion } from './versions.js';

export type PathClass = 'SUPPORTED' | 'REQUIRES_VALIDATION' | 'UNSUPPORTED';

export interface Hop {
  from: string;
  to: string;
  intermediate: boolean;
  pathClass: PathClass;
  notes: string[];
}

interface When {
  fromAtLeast?: string;
  fromBelow?: string;
  fromMajor?: number;
  fromMajorAtLeast?: number;
  fromMajorAtMost?: number;
  atLeast?: string;
  below?: string;
  edition?: string;
  always?: boolean;
}

interface HopSpec {
  from: string;
  to: string;
  class: PathClass;
  notes?: string[];
  classBelow?: { version: string; class: PathClass; notes?: string[] };
}

interface Matrix {
  notes: Record<string, string>;
  rules: Array<{ id: string; when: When; hops: HopSpec[] }>;
  gates: Array<{ when: When; text: string }>;
  gatesFallback?: string;
  solrRemoval?: { when: When };
}

let cached: Matrix | undefined;

function matrix(): Matrix {
  if (cached) return cached;
  const file = path.join(dataDir(), 'upgrade-paths.yaml');
  const parsed = yaml.load(readFileSync(file, 'utf8')) as Partial<Matrix>;
  cached = {
    notes: parsed.notes ?? {},
    rules: parsed.rules ?? [],
    gates: parsed.gates ?? [],
    gatesFallback: parsed.gatesFallback,
    solrRemoval: parsed.solrRemoval,
  };
  return cached;
}

/** Recarga la matriz (tests o cambios en caliente). */
export function reloadUpgradeMatrix(): void {
  cached = undefined;
}

const substitute = (text: string, from: string, to: string): string => text.replace(/\$FROM/g, from).replace(/\$TO/g, to);

function whenMatches(when: When, ctx: { fromVersion: string; fromMajor: number; toVersion: string; edition: string }): boolean {
  if (when.always) return true;
  if (when.fromAtLeast && !atLeast(ctx.fromVersion, when.fromAtLeast)) return false;
  if (when.fromBelow && compareVersions(ctx.fromVersion, when.fromBelow) >= 0) return false;
  if (when.fromMajor !== undefined && ctx.fromMajor !== when.fromMajor) return false;
  if (when.fromMajorAtLeast !== undefined && ctx.fromMajor < when.fromMajorAtLeast) return false;
  if (when.fromMajorAtMost !== undefined && ctx.fromMajor > when.fromMajorAtMost) return false;
  if (when.atLeast && !atLeast(ctx.toVersion, when.atLeast)) return false;
  if (when.below && compareVersions(ctx.toVersion, when.below) >= 0) return false;
  if (when.edition && ctx.edition.toUpperCase() !== when.edition.toUpperCase()) return false;
  return true;
}

/** Ruta soportada por el fabricante desde `from` hasta `to`, segun la matriz de datos. */
export function resolveUpgradePath(fromRaw: string, to: string): Hop[] {
  const fromMajor = parseVersion(fromRaw)[0] ?? 0;
  const data = matrix();
  const rule = data.rules.find((r) => whenMatches(r.when, { fromVersion: fromRaw, fromMajor, toVersion: to, edition: '' }));
  if (!rule) {
    return [];
  }
  const total = rule.hops.length;
  return rule.hops.map((hop, index) => {
    const below = hop.classBelow && compareVersions(fromRaw, hop.classBelow.version) < 0;
    const pathClass = below ? (hop.classBelow as NonNullable<HopSpec['classBelow']>).class : hop.class;
    const noteIds = below ? (hop.classBelow?.notes ?? hop.notes ?? []) : (hop.notes ?? []);
    return {
      from: substitute(hop.from, fromRaw, to),
      to: substitute(hop.to, fromRaw, to),
      intermediate: index < total - 1,
      pathClass,
      notes: noteIds.map((id) => data.notes[id] ?? id),
    };
  });
}

/** Gates de breaking changes aplicables segun version destino y edicion. */
export function breakingChangeGates(targetVersion: string, edition: string): string[] {
  const data = matrix();
  const gates = data.gates
    .filter((g) => whenMatches(g.when, { fromVersion: targetVersion, fromMajor: parseVersion(targetVersion)[0] ?? 0, toVersion: targetVersion, edition }))
    .map((g) => substitute(g.text, targetVersion, targetVersion));
  if (gates.length === 0 && data.gatesFallback) {
    return [substitute(data.gatesFallback, targetVersion, targetVersion)];
  }
  return gates;
}

/** Requiere desmantelar Solr en el destino (segun la matriz). */
export function requiresSolrRemoval(targetVersion: string, edition: string): boolean {
  const data = matrix();
  if (!data.solrRemoval) return false;
  return whenMatches(data.solrRemoval.when, {
    fromVersion: targetVersion,
    fromMajor: parseVersion(targetVersion)[0] ?? 0,
    toVersion: targetVersion,
    edition,
  });
}

/** Vista de solo lectura de la matriz (para skills/diagnostico). */
export function upgradeMatrix(): Matrix {
  return matrix();
}
