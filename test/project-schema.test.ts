import { readFile } from 'node:fs/promises';
import path from 'node:path';
import yaml from 'js-yaml';
import { describe, expect, it } from 'vitest';
import { validateProject } from '../src/domain/wizard.js';

describe('project.schema', () => {
  it('example.yaml valida contra project.schema.json', async () => {
    const text = await readFile(path.resolve('data/projects/example.yaml'), 'utf8');
    const errors = await validateProject(yaml.load(text));
    expect(errors).toEqual([]);
  });
});
