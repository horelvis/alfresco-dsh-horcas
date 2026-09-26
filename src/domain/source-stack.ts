/**
 * Inventario del STACK del ORIGEN desde su despliegue (docker-compose + Dockerfiles), en solo lectura:
 * - servicios por rol (repositorio, Share, transform, busqueda, LDAP, proxy, BD, ActiveMQ, otros);
 * - CUSTOMIZACIONES que las imagenes estandar del destino NO traen: AMPs, JARs y config copiados por los
 *   Dockerfiles del repositorio/Share.
 * El migrador no las instala: las DETECTA y AVISA (evidencia `modules`), y el humano decide.
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import yaml from 'js-yaml';

export type ServiceRole = 'repository' | 'share' | 'transform' | 'search' | 'ldap' | 'proxy' | 'database' | 'activemq' | 'ui' | 'other';

export interface SourceService {
  name: string;
  role: ServiceRole;
  image?: string;
  /** Imagen base del Dockerfile (FROM) si el servicio se construye. */
  baseImage?: string;
  build: boolean;
}

export interface Customization {
  service: string;
  kind: 'amp' | 'jar' | 'config';
  /** Ruta relativa al contexto de build del servicio. */
  file: string;
  /** Ruta absoluta en disco. */
  path: string;
}

export interface SourceStack {
  dir: string;
  services: SourceService[];
  customizations: Customization[];
  warnings: string[];
}

const ROLE_RULES: Array<[ServiceRole, RegExp]> = [
  ['transform', /transform|shared-file-store|ocr|tengine/i],
  ['share', /share/i],
  ['search', /solr|search-services|elasticsearch|opensearch|batch-indexing|live-indexing/i],
  ['ldap', /ldap/i],
  ['proxy', /nginx|traefik|proxy|acs-ingress/i],
  ['database', /postgres|mysql|mariadb|oracle|mssql/i],
  ['activemq', /activemq/i],
  ['ui', /content-app|digital-workspace|control-center/i],
  ['repository', /content-repository|^alfresco$/i],
];

export function roleOf(name: string, image = ''): ServiceRole {
  for (const [role, pattern] of ROLE_RULES) if (pattern.test(image) || pattern.test(name)) return role;
  return 'other';
}

/** Variables `${VAR}` / `${VAR:-def}` resueltas con el `.env` del despliegue. */
export function expandVars(value: string, env: Record<string, string>): string {
  return value.replace(/\$\{([A-Za-z0-9_]+)(?::?-([^}]*))?\}/g, (_m, key: string, def?: string) => env[key] ?? def ?? '');
}

export function parseDotEnv(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const m = /^\s*([A-Za-z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && !line.trim().startsWith('#')) env[m[1]!] = m[2]!.replace(/^['"]|['"]$/g, '');
  }
  return env;
}

/** Origenes de `COPY`/`ADD` de un Dockerfile (sin flags, sin URLs) y su imagen base. */
export function parseDockerfile(text: string, env: Record<string, string> = {}): { from?: string; sources: string[] } {
  const args: Record<string, string> = { ...env };
  let from: string | undefined;
  const sources: string[] = [];
  for (const raw of text.replace(/\\\n/g, ' ').split('\n')) {
    const line = raw.trim();
    const arg = /^ARG\s+([A-Za-z0-9_]+)(?:=(\S+))?/i.exec(line);
    if (arg) {
      if (arg[2] && !(arg[1]! in args)) args[arg[1]!] = arg[2];
      continue;
    }
    const fromMatch = /^FROM\s+(\S+)/i.exec(line);
    if (fromMatch) from = expandVars(fromMatch[1]!.replace(/\$([A-Za-z0-9_]+)/g, '${$1}'), args);
    const copy = /^(?:COPY|ADD)\s+(.+)$/i.exec(line);
    if (copy) {
      const parts = copy[1]!.split(/\s+/).filter((p) => !p.startsWith('--'));
      for (const src of parts.slice(0, -1)) if (!/^https?:/.test(src)) sources.push(src);
    }
  }
  return { ...(from ? { from } : {}), sources };
}

async function listFiles(root: string, limit = 500): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= limit || e.name.startsWith('.')) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) await walk(full);
      else out.push(full);
    }
  };
  const info = await stat(root).catch(() => undefined);
  if (info?.isFile()) return [root];
  if (info?.isDirectory()) await walk(root);
  return out;
}

const kindOf = (file: string): Customization['kind'] =>
  file.endsWith('.amp') ? 'amp' : file.endsWith('.jar') ? 'jar' : 'config';

// Ficheros de soporte del propio build (no son customizaciones del producto).
const BUILD_NOISE = /(^|\/)(wait-for-something\.sh|[^/]*entrypoint[^/]*\.sh|Dockerfile)$/;

export async function scanSourceStack(dir: string): Promise<SourceStack> {
  const warnings: string[] = [];
  const composeName = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yaml', 'compose.yml'];
  let composeText = '';
  for (const name of composeName) {
    composeText = await readFile(path.join(dir, name), 'utf8').catch(() => '');
    if (composeText) break;
  }
  if (!composeText) return { dir, services: [], customizations: [], warnings: [`sin docker-compose en ${dir}`] };
  const env = parseDotEnv(await readFile(path.join(dir, '.env'), 'utf8').catch(() => ''));
  const doc = (yaml.load(composeText) ?? {}) as { services?: Record<string, { image?: string; build?: string | { context?: string; dockerfile?: string; args?: Record<string, string> | string[] } }> };
  const services: SourceService[] = [];
  const customizations: Customization[] = [];
  for (const [name, svc] of Object.entries(doc.services ?? {})) {
    const image = svc.image ? expandVars(svc.image, env) : undefined;
    const build = svc.build;
    if (!build) {
      services.push({ name, role: roleOf(name, image), ...(image ? { image } : {}), build: false });
      continue;
    }
    const context = path.resolve(dir, typeof build === 'string' ? build : (build.context ?? '.'));
    const dockerfile = path.resolve(context, typeof build === 'string' ? 'Dockerfile' : (build.dockerfile ?? 'Dockerfile'));
    const buildArgs: Record<string, string> = { ...env };
    if (typeof build !== 'string' && build.args) {
      const entries = Array.isArray(build.args) ? build.args.map((a) => a.split('=') as [string, string]) : Object.entries(build.args);
      for (const [k, v] of entries) buildArgs[k] = expandVars(String(v ?? ''), env);
    }
    const text = await readFile(dockerfile, 'utf8').catch(() => '');
    if (!text) warnings.push(`${name}: no se pudo leer ${dockerfile}`);
    const parsed = parseDockerfile(text, buildArgs);
    const role = roleOf(name, parsed.from ?? image);
    services.push({ name, role, ...(image ? { image } : {}), ...(parsed.from ? { baseImage: parsed.from } : {}), build: true });
    // Solo repositorio y Share: sus customizaciones son las que el destino estandar no trae.
    if (role !== 'repository' && role !== 'share') continue;
    for (const src of parsed.sources) {
      for (const file of await listFiles(path.resolve(context, src))) {
        const rel = path.relative(context, file);
        if (!BUILD_NOISE.test(rel) && !customizations.some((c) => c.service === name && c.file === rel)) {
          customizations.push({ service: name, kind: kindOf(file), file: rel, path: file });
        }
      }
    }
  }
  return { dir, services, customizations, warnings };
}

/** Resumen para evidencia/informe: servicios por rol y customizaciones por tipo. */
export function summarizeStack(stack: SourceStack): string {
  const roles = stack.services
    .filter((s) => s.role !== 'other')
    .map((s) => `${s.name}(${s.role}${s.build ? ', build propio' : ''})`)
    .join(', ');
  const by = (kind: Customization['kind']) => stack.customizations.filter((c) => c.kind === kind);
  const amps = by('amp').map((c) => path.basename(c.file));
  return `servicios: ${roles || '—'} · customizaciones: ${amps.length} AMPs [${amps.join(', ')}], ${by('jar').length} JARs, ${by('config').length} ficheros de config`;
}
