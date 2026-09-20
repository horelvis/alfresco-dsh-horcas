/** Carga de la configuracion de proyecto (subconjunto del schema de migracion). */
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
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

export interface ProjectHost {
  host: string;
  port?: number;
  user?: string;
  keyFile?: string;
}

export interface ProjectConfig {
  project: string;
  /** clone | test | prod. PROD exige un ensayo validado (flujo ensayo->produccion). */
  stage: Stage;
  access: { mode: string; hosts: Record<string, ProjectHost> };
  source: {
    baseUrl?: string;
    edition?: string;
    version: string;
    database?: ProjectDatabase;
    contentStore?: { type?: string; path?: string; via?: string; volume?: string };
    search?: { engine?: string };
  };
  target: {
    version: string;
    edition?: string;
    deployment?: string;
    /** URL REST del DESTINO (verificacion de version/salud). */
    baseUrl?: string;
    database?: ProjectDatabase;
    contentStore?: { type?: string; path?: string; volume?: string };
    search?: { engine?: string };
  };
  migration: {
    contentStrategy?: string;
    dbStrategy?: string;
    indexStrategy?: string;
    coherencePolicy?: string;
  };
  raw: Record<string, unknown>;
}

export function parseProjectYaml(text: string): ProjectConfig {
  const raw = (yaml.load(text) ?? {}) as Record<string, unknown>;
  const source = (raw.source ?? {}) as Record<string, unknown>;
  const target = (raw.target ?? {}) as Record<string, unknown>;
  const access = (raw.access ?? {}) as Record<string, unknown>;
  const migration = (raw.migration ?? {}) as Record<string, unknown>;
  const coherence = (migration.coherence ?? {}) as Record<string, unknown>;
  const hostsRaw = (access.hosts ?? {}) as Record<string, Record<string, unknown>>;
  const hosts: Record<string, ProjectHost> = {};
  for (const [key, value] of Object.entries(hostsRaw)) {
    const auth = (value.auth ?? {}) as Record<string, unknown>;
    hosts[key] = {
      host: String(value.host ?? ''),
      port: value.port ? Number(value.port) : undefined,
      user: value.user ? String(value.user) : undefined,
      keyFile: auth.keyFile ? String(auth.keyFile).replace(/^~/, process.env.HOME ?? '~') : undefined,
    };
  }
  const version = String(source.version ?? '');
  const stage = String(raw.stage ?? 'test').toLowerCase();
  return {
    project: String(raw.project ?? 'unnamed'),
    stage: (['clone', 'test', 'prod'].includes(stage) ? stage : 'test') as Stage,
    access: { mode: String(access.mode ?? 'local'), hosts },
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
      baseUrl: target.baseUrl ? String(target.baseUrl) : undefined,
      database: target.database as ProjectDatabase | undefined,
      contentStore: target.contentStore as ProjectConfig['target']['contentStore'],
      search: target.search as ProjectConfig['target']['search'],
    },
    migration: {
      contentStrategy: migration.contentStrategy ? String(migration.contentStrategy) : undefined,
      dbStrategy: migration.dbStrategy ? String(migration.dbStrategy) : undefined,
      indexStrategy: migration.indexStrategy ? String(migration.indexStrategy) : undefined,
      coherencePolicy: coherence.policy ? String(coherence.policy) : undefined,
    },
    raw,
  };
}

/**
 * Rutas candidatas para un proyecto: acepta una **ruta** o un **nombre** de proyecto. Un nombre (sin
 * extension) se busca como `<nombre>.yaml` en el workspace y en `data/projects/`.
 */
export function projectCandidates(projectPath: string, cwd = process.cwd(), root = dataDir()): string[] {
  const resolved = path.isAbsolute(projectPath) ? projectPath : path.resolve(cwd, projectPath);
  const candidates = [resolved];
  if (!path.isAbsolute(projectPath)) candidates.push(path.resolve(root, projectPath));
  if (!/\.(?:ya?ml)$/i.test(projectPath)) {
    candidates.push(`${resolved}.yaml`, `${resolved}.yml`);

    candidates.push(path.resolve(root, `${projectPath}.yaml`));
  }
  return [...new Set(candidates)];
}

/**
 * Resuelve el proyecto **del workspace** (sin ruta): `MIGRATOR_PROJECT` si esta definido, o el unico
 * YAML del workspace que no sea un compose. Reutiliza el concepto de workspace del arnes.
 */
export async function resolveWorkspaceProject(cwd: string, env: NodeJS.ProcessEnv = process.env): Promise<ProjectConfig> {
  if (env.MIGRATOR_PROJECT) return loadProject(env.MIGRATOR_PROJECT, cwd);
  const entries = await readdir(cwd).catch(() => [] as string[]);
  const candidates = entries.filter((name) => /\.(?:ya?ml)$/i.test(name) && !/^(?:docker-)?compose/i.test(name));
  if (candidates.length === 1) return loadProject(candidates[0] as string, cwd);
  throw new Error(
    candidates.length === 0
      ? `No hay proyecto de migracion en el workspace (${cwd}). Crea el YAML o define MIGRATOR_PROJECT.`
      : `Varios YAML en el workspace (${candidates.join(', ')}); pasa project o define MIGRATOR_PROJECT.`,
  );
}

/**
 * Carga un proyecto a partir de una ruta/nombre, o **del workspace** si se omite. Las rutas relativas
 * se resuelven contra `cwd` (el cwd de la sesion).
 */
export async function loadProject(projectPath?: string, cwd: string = process.cwd()): Promise<ProjectConfig> {
  if (projectPath === undefined || projectPath.trim() === '') return resolveWorkspaceProject(cwd);
  const candidates = projectCandidates(projectPath, cwd);
  const file = candidates.find((candidate) => existsSync(candidate));
  if (file === undefined) {
    throw new Error(
      `Proyecto no encontrado. Probado: ${candidates.join(', ')}. Crea el YAML con migrator_wizard o corrige la ruta.`,
    );
  }
  return parseProjectYaml(await readFile(file, 'utf8'));
}

export function projectSchemaPath(): string {
  return path.join(dataDir(), 'project.schema.json');
}
