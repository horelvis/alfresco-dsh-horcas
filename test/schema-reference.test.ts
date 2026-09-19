import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { chooseVersion, loadSchemaReference, parseSchemaReference } from '../src/domain/schema-reference.js';

const dataDir = path.resolve(process.cwd(), 'data');

describe('chooseVersion', () => {
  const available = ['6.0.0', '7.1.0', '25.3.0', '26.2.0'];

  it('elige la mayor <= pedida', () => {
    expect(chooseVersion('26.0.0', available)).toBe('25.3.0');
    expect(chooseVersion('26.2.0', available)).toBe('26.2.0');
  });

  it('si la pedida es anterior a todas, usa la menor', () => {
    expect(chooseVersion('4.2.0', available)).toBe('6.0.0');
  });
});

describe('Schema-Reference', () => {
  it('parsea la referencia 26.2.0 con PK/unicos correctos', async () => {
    const xml = await readFile(path.join(dataDir, 'schema-references', '26.2.0', 'Schema-Reference-ALF.xml'), 'utf8');
    const ref = parseSchemaReference('26.2.0', xml);

    expect(ref.dbPrefix).toBe('alf_');
    expect(ref.tables.size).toBe(45);
    expect(ref.tables.get('alf_node')?.primaryKey).toEqual(['id']);
    expect(ref.tables.get('alf_node')?.uniqueIndexes[0]?.columns).toEqual(['store_id', 'uuid']);
    expect(ref.tables.get('alf_node_properties')?.primaryKey).toEqual(['node_id', 'qname_id', 'list_index', 'locale_id']);
  });

  it('loadSchemaReference resuelve la version de la peticion', async () => {
    const ref = await loadSchemaReference('25.3.9', dataDir);
    expect(ref.version).toBe('25.3.0');
  });
});
