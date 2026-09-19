/**
 * Integridad del esquema PostgreSQL vs la referencia de la version (mismo criterio que el core Spring):
 * detecta tablas criticas ausentes, PK ausente/incorrecta y unicos ausentes. Base del defecto de la
 * incidencia "esquema sin PK/unicidad + CDC" (filas duplicadas).
 */
import type pg from 'pg';
import { CONSTRAINTS_SQL, queryRows } from '../infra/pg.js';
import type { SchemaReference } from './schema-reference.js';

export const CRITICAL_TABLES = [
  'alf_node',
  'alf_node_properties',
  'alf_node_aspects',
  'alf_content_url',
  'alf_transaction',
  'alf_acl_change_set',
] as const;

export interface LiveTable {
  primaryKey: string[] | null;
  uniqueIndexes: Set<string>;
}

export type MismatchKind = 'MISSING_TABLE' | 'MISSING_PK' | 'WRONG_PK' | 'MISSING_UNIQUE';

export interface Mismatch {
  table: string;
  kind: MismatchKind;
  expected: string;
  actual: string;
}

export interface Integrity {
  referenceVersion: string;
  tablesChecked: number;
  mismatches: Mismatch[];
  healthy: boolean;
}

const key = (columns: string[]): string => columns.join(',');

export function liveCatalogFromRows(rows: Record<string, unknown>[]): Map<string, LiveTable> {
  const primary = new Map<string, string[]>();
  const unique = new Map<string, Set<string>>();
  for (const row of rows) {
    const table = String(row.table_name);
    const cols = String(row.cols ?? '')
      .split(',')
      .map((c) => c.trim())
      .filter(Boolean);
    if (row.contype === 'p') {
      primary.set(table, cols);
    } else if (row.contype === 'u') {
      const set = unique.get(table) ?? new Set<string>();
      set.add(key(cols));
      unique.set(table, set);
    }
  }
  const live = new Map<string, LiveTable>();
  for (const [table, pk] of primary) {
    live.set(table, { primaryKey: pk, uniqueIndexes: unique.get(table) ?? new Set() });
  }
  for (const [table, set] of unique) {
    if (!live.has(table)) {
      live.set(table, { primaryKey: null, uniqueIndexes: set });
    }
  }
  return live;
}

export async function liveCatalog(client: pg.Client): Promise<Map<string, LiveTable>> {
  return liveCatalogFromRows(await queryRows(client, CONSTRAINTS_SQL));
}

export function compare(reference: SchemaReference, live: Map<string, LiveTable>): Integrity {
  const mismatches: Mismatch[] = [];
  for (const critical of CRITICAL_TABLES) {
    if (!live.has(critical)) {
      mismatches.push({ table: critical, kind: 'MISSING_TABLE', expected: 'tabla presente', actual: 'ausente' });
    }
  }
  let checked = 0;
  for (const [name, expected] of reference.tables) {
    const actual = live.get(name);
    if (!actual) continue;
    checked++;
    if (expected.primaryKey.length > 0) {
      if (actual.primaryKey === null) {
        mismatches.push({ table: name, kind: 'MISSING_PK', expected: key(expected.primaryKey), actual: 'sin PK' });
      } else if (key(actual.primaryKey) !== key(expected.primaryKey)) {
        mismatches.push({
          table: name,
          kind: 'WRONG_PK',
          expected: key(expected.primaryKey),
          actual: key(actual.primaryKey),
        });
      }
    }
    for (const unique of expected.uniqueIndexes) {
      if (!actual.uniqueIndexes.has(key(unique.columns))) {
        mismatches.push({
          table: name,
          kind: 'MISSING_UNIQUE',
          expected: `${unique.name}(${key(unique.columns)})`,
          actual: 'ausente',
        });
      }
    }
  }
  return { referenceVersion: reference.version, tablesChecked: checked, mismatches, healthy: mismatches.length === 0 };
}

export function describe(integrity: Integrity): string {
  if (integrity.healthy) {
    return `referencia=${integrity.referenceVersion} tablas=${integrity.tablesChecked} (PK/unicidad OK)`;
  }
  const count = (kind: MismatchKind) => integrity.mismatches.filter((m) => m.kind === kind).length;
  const detail = integrity.mismatches
    .slice(0, 5)
    .map((m) => `${m.table}[${m.kind} ${m.actual}]`)
    .join(' ');
  return (
    `referencia=${integrity.referenceVersion} tablas=${integrity.tablesChecked}` +
    ` | ausentes=${count('MISSING_TABLE')} PK_ausente=${count('MISSING_PK')}` +
    ` PK_incorrecta=${count('WRONG_PK')} unicos_ausentes=${count('MISSING_UNIQUE')}` +
    (detail ? ` · ${detail}` : '')
  );
}
