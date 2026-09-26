import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { READ_ONLY_TOOLS, WRITE_TOOLS } from '../src/security/policy.js';

describe('politica: toda tool migrator_* registrada esta clasificada', () => {
  it('ninguna tool del plugin cae en "Tool desconocida del migrador"', () => {
    const dir = path.resolve(__dirname, '../src/tools');
    const registered = readdirSync(dir)
      .flatMap((f) => [...readFileSync(path.join(dir, f), 'utf8').matchAll(/name: '(migrator_[a-z_]+)'/g)].map((m) => m[1]!));
    const known = new Set<string>([...READ_ONLY_TOOLS, ...WRITE_TOOLS]);
    expect(registered.filter((n) => !known.has(n))).toEqual([]);
  });
});
