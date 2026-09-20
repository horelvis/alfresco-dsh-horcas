/**
 * Wizard de configuracion (E18): detecta antes que pregunta, genera el YAML del proyecto, lo valida
 * contra el JSON Schema y previsualiza ruta/estrategia antes de escribirlo.
 *
 * Portado de InitWizard. Modos: no interactivo (answers), deteccion via Discovery REST, o por
 * defecto un YAML minimo valido.
 */
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import AjvModule, { type ErrorObject } from 'ajv/dist/2020.js';
import addFormatsModule from 'ajv-formats';
import yaml from 'js-yaml';
import { dataDir } from './data-dir.js';
import { resolveUpgradePath } from './upgrade-paths.js';
import { assessSource, discoverRest } from './assessment.js';
import type { ProjectConfig } from './project-config.js';

// Interop CJS/ESM: ajv publica `module.exports = Ajv`.
const Ajv = ((AjvModule as unknown as { default?: typeof AjvModule }).default ?? AjvModule) as unknown as new (
  options: Record<string, unknown>,
) => { compile(schema: object): ((data: unknown) => boolean) & { errors?: ErrorObject[] | null } };
const addFormats = ((addFormatsModule as unknown as { default?: typeof addFormatsModule }).default ?? addFormatsModule) as unknown as (ajv: unknown) => void;

export interface WizardInputs {
  name?: string;
  baseUrl?: string;
  edition?: string;
  version?: string;
  dbEngine?: string;
  dbHost?: string;
  dbPort?: number;
  dbName?: string;
  dbUser?: string;
  storeType?: string;
  storePath?: string;
  targetVersion?: string;
  targetEdition?: string;
  targetSearch?: string;
  sourceSearch?: string;
  /** Consultar el Discovery REST del origen para rellenar version/edicion. */
  detect?: boolean;
}

export interface WizardResult {
  project: string;
  yaml: string;
  errors: string[];
  preview: { hops: string[]; note: string };
}

const slug = (value: string): string => value.toLowerCase().replace(/[^a-z0-9.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 63) || 'migration';

/** Valida un objeto de proyecto contra `data/project.schema.json`. */
export async function validateProject(root: unknown): Promise<string[]> {
  const schema = JSON.parse(await readFile(path.join(dataDir(), 'project.schema.json'), 'utf8')) as object;
  const ajv = new Ajv({ allErrors: true, strict: false });
  addFormats(ajv);
  const validate = ajv.compile(schema);
  if (validate(root)) return [];
  return (validate.errors ?? []).map((error: ErrorObject) => `${error.instancePath || '/'} ${error.message ?? ''}`.trim());
}

/** Construye el objeto de proyecto (sin escribir) desde las entradas del wizard. */
export async function buildProject(inputs: WizardInputs): Promise<Record<string, unknown>> {
  let edition = inputs.edition ?? 'CE';
  let version = inputs.version ?? '7.1.1';
  if (inputs.detect && inputs.baseUrl) {
    const detected = await discoverRest(inputs.baseUrl, process.env.MIGRATOR_SRC_USER, process.env.MIGRATOR_SRC_PASSWORD);
    if (detected) {
      edition = detected.edition;
      version = detected.version;
    }
  }
  const storeType = (inputs.storeType ?? 'FS').toUpperCase();
  return {
    project: slug(inputs.name ?? 'migration'),
    access: { mode: 'local' },
    source: {
      baseUrl: inputs.baseUrl ?? 'http://localhost:8080/alfresco',
      edition,
      version,
      auth: 'builtin',
      database: {
        engine: inputs.dbEngine ?? 'postgresql',
        host: inputs.dbHost ?? 'localhost',
        port: inputs.dbPort ?? 5432,
        name: inputs.dbName ?? 'alfresco',
        user: inputs.dbUser ?? 'alfresco',
      },
      contentStore: storeType === 'FS'
        ? { type: 'FS', path: inputs.storePath ?? 'alf_data/contentstore', via: 'local' }
        : { type: storeType, bucket: inputs.storePath ?? 'bucket' },
      search: { engine: inputs.sourceSearch ?? 'solr' },
    },
    target: {
      version: inputs.targetVersion ?? '26.2',
      edition: inputs.targetEdition ?? edition,
      deployment: 'compose',
      database: { engine: 'postgresql' },
      contentStore: { type: 'FS', path: '/alf_data-26/contentstore' },
      search: { engine: inputs.targetSearch ?? 'opensearch' },
    },
    migration: { contentStrategy: 'C2', dbStrategy: 'D2', indexStrategy: 'I2', parallelism: 4, coherence: { mode: 'full', policy: 'FAIL_ON_DANGLING' } },
    estimation: { changeRatePerDay: 0.01 },
    jira: { mode: 'off' },
    ai: { enabled: false },
  };
}

export interface WizardOptions {
  inputs?: WizardInputs;
  out?: string;
  /** Directorio del workspace donde se escribe el YAML si no se da `out` (defecto: cwd). */
  cwd?: string;
  force?: boolean;
  dryRun?: boolean;
}

/** Ejecuta el wizard: construye, valida y (si no es dry-run) escribe el YAML. */
export async function runWizard(options: WizardOptions = {}): Promise<WizardResult> {
  const root = await buildProject(options.inputs ?? {});
  const errors = await validateProject(root);
  const project = String(root.project);
  const source = root.source as { version: string };
  const target = root.target as { version: string };
  const hops = resolveUpgradePath(source.version, target.version).map((h) => `${h.from}->${h.to} [${h.pathClass}]`);

  if (errors.length > 0) {
    return { project, yaml: '', errors, preview: { hops, note: 'no se escribio (schema invalido)' } };
  }
  const yamlText = yaml.dump(root, { noRefs: true, lineWidth: 120 });

  if (!options.dryRun) {
    const destination = options.out ?? path.join(options.cwd ?? process.cwd(), `${project}.yaml`);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, yamlText, 'utf8');
    return { project, yaml: yamlText, errors: [], preview: { hops, note: `escrito ${destination}` } };
  }
  return { project, yaml: yamlText, errors: [], preview: { hops, note: 'dry-run: no escrito' } };
}

/** Previsualiza el proyecto cargado: ruta + inventario basico (si hay JDBC). */
export async function previewProject(project: ProjectConfig): Promise<{ hops: string[]; assessment?: string }> {
  const hops = resolveUpgradePath(project.source.version, project.target.version).map((h) => `${h.from}->${h.to} [${h.pathClass}]`);
  try {
    const assessment = await assessSource(project, {
      restUser: process.env.MIGRATOR_SRC_USER,
      restPassword: process.env.MIGRATOR_SRC_PASSWORD,
    });
    return { hops, assessment: `ACS ${assessment.version} ${assessment.edition} · nodos=${assessment.nodes} ficheros=${assessment.fileCount}` };
  } catch {
    return { hops };
  }
}
