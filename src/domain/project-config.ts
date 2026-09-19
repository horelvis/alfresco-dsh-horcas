/** Carga de la configuracion de proyecto (subconjunto del schema de migracion). */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import yaml from 'js-yaml';
import { dataDir } from './data-dir.js';
import type { Stage } from './experience.js';

export interface ProjectDatabase {
  engine?: string;
  host?: string;
  port?: number;
  name?: string;
  user?: string;
}

export interface ProjectConfig {
  project: string;
  /** clone | test | prod. PROD exige un ensayo validado (flujo ensayo->produccion). */
  stage: Stage;
  source: {
    baseUrl?: string;
    edition?: string;
    version: string;
    database?: ProjectDatabase;
    contentStore?: { type?: string; path?: string };
    search?: { engine?: string };
  };
  target: {
    version: string;
    edition?: string;
    deployment?: string;
    search?: { engine?: string };
  };
  raw: Record<string, unknown>;
}

export function parseProjectYaml(text: string): ProjectConfig {
  const raw = (yaml.load(text) ?? {}) as Record<string, unknown>;
  const source = (raw.source ?? {}) as Record<string, unknown>;
  const target = (raw.target ?? {}) as Record<string, unknown>;
  const version = String(source.version ?? '');
  const stage = String(raw.stage ?? 'test').toLowerCase();
  return {
    project: String(raw.project ?? 'unnamed'),
    stage: (['clone', 'test', 'prod'].includes(stage) ? stage : 'test') as Stage,
    source: {
      baseUrl: source.baseUrl ? String(source.baseUrl) : undefined,
      edition: source.edition ? String(source.edition) : undefined,
      version,
      database: source.database as ProjectDatabase | undefined,
      contentStore: source.contentStore as ProjectConfig['source']['contentStore'],
      search: source.search as ProjectConfig['source']['search'],
    },
    target: {
      version: String(target.version ?? ''),
      edition: target.edition ? String(target.edition) : undefined,
      deployment: target.deployment ? String(target.deployment) : undefined,
      search: target.search as ProjectConfig['target']['search'],
    },
    raw,
  };
}

export async function loadProject(projectPath: string): Promise<ProjectConfig> {
  const resolved = path.isAbsolute(projectPath) ? projectPath : path.resolve(process.cwd(), projectPath);
  return parseProjectYaml(await readFile(resolved, 'utf8'));
}

export function projectSchemaPath(): string {
  return path.join(dataDir(), 'project.schema.json');
}
