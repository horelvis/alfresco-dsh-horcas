/**
 * Esquema de referencia de Alfresco (`Schema-Reference-ALF.xml`): el mismo fichero contra el que el
 * propio ACS valida su base de datos al arrancar. Se usa para comprobar PK/UNIQUE <b>por version</b>
 * (el esquema cambia entre familias; no se hardcodea la lista de tablas).
 */
import { XMLParser } from 'fast-xml-parser';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { compareTuple, parseVersion } from './versions.js';

export interface UniqueIndex {
  name: string;
  columns: string[];
}

export interface TableExpectation {
  name: string;
  primaryKey: string[];
  uniqueIndexes: UniqueIndex[];
}

export interface SchemaReference {
  version: string;
  dbPrefix: string;
  tables: Map<string, TableExpectation>;
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  isArray: (name) => ['table', 'index', 'columnname', 'sequence'].includes(name),
});

function toArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function textOf(node: unknown): string {
  if (node === null || node === undefined) return '';
  if (typeof node === 'object') {
    const record = node as Record<string, unknown>;
    return '#text' in record ? String(record['#text']).trim() : '';
  }
  return String(node).trim();
}

function columnNames(holder: unknown): string[] {
  const node = holder as { columnnames?: { columnname?: unknown } } | undefined;
  return toArray(node?.columnnames?.columnname)
    .map((entry, index) => ({
      text: textOf(entry),
      order:
        typeof entry === 'object' && entry !== null && '@_order' in (entry as Record<string, unknown>)
          ? Number((entry as Record<string, unknown>)['@_order'])
          : index,
    }))
    .sort((a, b) => a.order - b.order)
    .map((entry) => entry.text)
    .filter(Boolean);
}

export function parseSchemaReference(version: string, xml: string): SchemaReference {
  const doc = parser.parse(xml) as { schema?: { '@_dbprefix'?: string; objects?: { table?: unknown } } };
  const root = doc.schema ?? {};
  const tables = new Map<string, TableExpectation>();
  for (const raw of toArray(root.objects?.table)) {
    const table = raw as {
      '@_name'?: string;
      primarykey?: unknown;
      indexes?: { index?: unknown };
    };
    const name = String(table['@_name'] ?? '');
    if (!name) continue;
    const indexes = toArray((table.indexes ?? {}).index)
      .filter((idx) => String((idx as { '@_unique'?: string })['@_unique']).toLowerCase() === 'true')
      .map((idx) => ({
        name: String((idx as { '@_name'?: string })['@_name'] ?? ''),
        columns: columnNames(idx),
      }));
    tables.set(name, {
      name,
      primaryKey: columnNames(table.primarykey),
      uniqueIndexes: indexes,
    });
  }
  return { version, dbPrefix: String(root['@_dbprefix'] ?? 'alf_'), tables };
}

/** Version disponible elegida para la pedida (mayor <= pedida; si no, la menor). */
export function chooseVersion(requested: string, available: string[]): string {
  const wanted = parseVersion(requested);
  const sorted = [...available].sort((a, b) => compareTuple(parseVersion(a), parseVersion(b)));
  let chosen: string | undefined;
  for (const candidate of sorted) {
    if (compareTuple(parseVersion(candidate), wanted) <= 0) {
      chosen = candidate;
    } else {
      break;
    }
  }
  return chosen ?? (sorted[0] as string);
}

export async function availableVersions(dataDir: string): Promise<string[]> {
  const dir = path.join(dataDir, 'schema-references');
  const entries = await readdir(dir, { withFileTypes: true });
  return entries.filter((e) => e.isDirectory()).map((e) => e.name);
}

/** Carga la referencia de la version (exacta o la mayor <= pedida). */
export async function loadSchemaReference(requested: string, dataDir: string): Promise<SchemaReference> {
  const available = await availableVersions(dataDir);
  if (available.length === 0) {
    throw new Error('No hay referencias de esquema disponibles en ' + dataDir);
  }
  const version = chooseVersion(requested, available);
  const file = path.join(dataDir, 'schema-references', version, 'Schema-Reference-ALF.xml');
  const xml = await readFile(file, 'utf8');
  return parseSchemaReference(version, xml);
}
