/**
 * Provision del destino en Docker Compose (E7): genera el compose de cada hop y levanta el stack.
 * El upgrade real del esquema lo ejecuta el propio ACS al arrancar; el migrador solo orquesta.
 *
 * Auto-skip con `MIGRATOR_DST_PROVISION`: auto (defecto, detecta stack en ejecucion),
 * managed (provisiona siempre) o external (nunca provisiona).
 *
 * Portado de ComposeFileBuilder/ComposeTargetProvisioner/ProvisionTargetStep.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { runShell, runShellWithInput, type ExecResult, type HostRef } from '../infra/exec.js';
import { memLimitForCompose, type AlfrescoMemory } from './memory.js';
import type { ProjectConfig } from './project-config.js';

export interface ComposeRequest {
  projectName: string;
  acsVersion: string;
  edition: string;
  deployment: string;
  database?: { engine?: string; host?: string; port?: number; name?: string; user?: string };
  search?: { engine?: string };
  withShare?: boolean;
  /** Memoria calculada para el repositorio (si falta, se usa un minimo seguro). */
  memory?: AlfrescoMemory;
  /** Carpeta base en el DESTINO para los datos de la version (content store + BD). Si falta, volumenes. */
  dataDir?: string;
}

const POSTGRES_IMAGE = 'postgres:15';
const ACTIVEMQ_IMAGE = 'alfresco/alfresco-activemq:5.18.6';

const dbImage = (engine: string | undefined): string => {
  switch ((engine ?? '').toLowerCase()) {
    case 'postgresql': return POSTGRES_IMAGE;
    case 'mysql': return 'mysql:8.0';
    case 'mariadb': return 'mariadb:10.11';
    default: throw new Error(`Motor sin imagen compose por defecto: ${engine}`);
  }
};

const searchImage = (engine: string | undefined): string => {
  switch ((engine ?? '').toUpperCase()) {
    case 'OPENSEARCH': return 'opensearchproject/opensearch:2.11.1';
    case 'ELASTICSEARCH': return 'docker.elastic.co/elasticsearch/elasticsearch:8.11.3';
    default: throw new Error('Solr no se despliega en el destino (26.x)');
  }
};

const repositoryImage = (edition: string, version: string): string => {
  const repository = edition === 'EE' ? 'quay.io/alfresco/alfresco-content-repository' : 'alfresco/alfresco-content-repository-community';
  return `${repository}:${version}`;
};

const jdbcUrl = (db: ComposeRequest['database'], host: string): string => {
  const engine = (db?.engine ?? 'postgresql').toLowerCase();
  return `jdbc:${engine}://${host}:${db?.port ?? 5432}/${db?.name ?? 'alfresco'}`;
};

/** Genera el YAML del compose de un hop. Sin secretos embebidos: variables de entorno. */
export function renderCompose(request: ComposeRequest): string {
  if ((request.deployment || 'compose').toLowerCase() !== 'compose') {
    throw new Error('renderCompose solo soporta Deployment.COMPOSE');
  }
  const db = request.database;
  const user = db?.user ?? 'alfresco';
  const search = (request.search?.engine ?? 'OPENSEARCH').toUpperCase();
  const lines: string[] = [];
  lines.push(`name: ${request.projectName}`);
  lines.push('services:');
  lines.push('  postgres:');
  lines.push(`    image: ${dbImage(db?.engine)}`);
  lines.push('    environment:');
  lines.push(`      POSTGRES_DB: ${db?.name ?? 'alfresco'}`);
  lines.push(`      POSTGRES_USER: ${user}`);
  lines.push('      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}');
  lines.push('    volumes:');
  lines.push(request.dataDir ? `      - ${request.dataDir}/pg-data:/var/lib/postgresql/data` : '      - alfresco-db:/var/lib/postgresql/data');
  lines.push('  activemq:');
  lines.push(`    image: ${ACTIVEMQ_IMAGE}`);
  lines.push('    environment:');
  lines.push('      ACTIVEMQ_ADMIN_LOGIN: ${ACTIVEMQ_ADMIN_LOGIN}');
  lines.push('      ACTIVEMQ_ADMIN_PASSWORD: ${ACTIVEMQ_ADMIN_PASSWORD}');
  lines.push('    ports:');
  lines.push('      - "8161:8161"');
  lines.push('  search:');
  lines.push(`    image: ${searchImage(search)}`);
  lines.push('    environment:');
  lines.push('      discovery.type: single-node');
  if (search !== 'ELASTICSEARCH') {
    lines.push('      plugins.security.disabled: "true"');
  }
  lines.push('  alfresco:');
  lines.push(`    image: ${repositoryImage(request.edition, request.acsVersion)}`);
  lines.push(`    mem_limit: ${request.memory ? memLimitForCompose(request.memory) : '2560m'}`);
  lines.push('    depends_on:');
  lines.push('      - postgres');
  lines.push('      - activemq');
  lines.push('      - search');
  lines.push('    environment:');
  lines.push(`      JAVA_OPTS: "${request.memory ? request.memory.javaOpts : '-Xms1g -Xmx2g'}"`);
  lines.push(`      DB_URL: ${jdbcUrl(db, 'postgres')}`);
  lines.push(`      DB_USERNAME: ${user}`);
  lines.push('      DB_PASSWORD: ${POSTGRES_PASSWORD}');
  lines.push('      ACTIVEMQ_ADMIN_LOGIN: ${ACTIVEMQ_ADMIN_LOGIN}');
  lines.push('      ACTIVEMQ_ADMIN_PASSWORD: ${ACTIVEMQ_ADMIN_PASSWORD}');
  lines.push('      ELASTICSEARCH_HOSTS: http://search:9200');
  lines.push('    ports:');
  lines.push('      - "8080:8080"');
  lines.push('    volumes:');
  lines.push(request.dataDir ? `      - ${request.dataDir}/alf-data:/usr/local/tomcat/alf_data` : '      - alfresco-content:/usr/local/tomcat/alf_data');
  if (request.withShare) {
    lines.push('  share:');
    lines.push(`    image: alfresco/alfresco-share:${request.acsVersion}`);
    lines.push('    environment:');
    lines.push('      REPO_HOST: alfresco');
    lines.push('      REPO_PORT: 8080');
    lines.push('    ports:');
    lines.push('      - "8081:8080"');
  }
  if (!request.dataDir) {
    lines.push('volumes:');
    lines.push('  alfresco-db:');
    lines.push('  alfresco-content:');
  }
  return lines.join('\n') + '\n';
}

const slug = (version: string): string => version.replace(/[^A-Za-z0-9._-]/g, '-');

/** Escribe el compose del hop en el directorio de trabajo y devuelve su ruta. */
export async function writeCompose(request: ComposeRequest, workDir: string): Promise<string> {
  const file = path.join(workDir, `docker-compose-${slug(request.acsVersion)}.yml`);
  await mkdir(workDir, { recursive: true });
  await writeFile(file, renderCompose(request), 'utf8');
  return file;
}

/** Decide si se omite la provision segun el modo. */
export function shouldSkipProvision(mode: string, destinationRunning: boolean): boolean {
  if (mode.toLowerCase() === 'external') return true;
  if (mode.toLowerCase() === 'auto') return destinationRunning;
  return false; // managed
}

export async function destinationRunning(host: HostRef): Promise<boolean> {
  if (host.name === 'local') return false;
  try {
    const result: ExecResult = await runShell(host, 'docker compose ls -q');
    return result.exitCode === 0 && result.stdout.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Proyectos docker compose a PARAR antes de levantar el stack del hop (para liberar puertos/recursos).
 * Con `explicit` se para solo ese; si no, los que parezcan de Alfresco; si hay uno solo, ese.
 */
export function stopTargets(projects: string[], explicit?: string): string[] {
  if (explicit && explicit.trim()) return [explicit.trim()];
  const alfresco = projects.filter((p) => /alfresco/i.test(p));
  if (alfresco.length > 0) return alfresco;
  return projects.length === 1 ? projects : [];
}

/** Para (down) los stacks que ya corren en el DESTINO antes de provisionar el hop. */
export async function stopRunningStacks(host: HostRef, env: NodeJS.ProcessEnv = process.env): Promise<string[]> {
  const listed = await runShell(host, 'docker compose ls -q');
  const projects = listed.exitCode === 0 ? listed.stdout.split('\n').map((s) => s.trim()).filter(Boolean) : [];
  const stopped: string[] = [];
  for (const project of stopTargets(projects, env.MIGRATOR_DST_COMPOSE_PROJECT)) {
    const result = await runShell(host, `docker compose -p "${project}" down --remove-orphans`);
    if (result.exitCode === 0) stopped.push(project);
  }
  return stopped;
}

/**
 * Valida el compose (parseo, sin tocar el daemon) con `docker compose -f - config -q`. Devuelve el error
 * o `undefined` si es valido. Se usa ANTES de parar stacks para no dejarlos caidos por un compose invalido.
 */
export async function validateCompose(host: HostRef, content: string): Promise<string | undefined> {
  const result = await runShellWithInput(host, 'docker compose -f - config -q', content);
  return result.exitCode === 0 ? undefined : result.stderr.trim() || result.stdout.trim() || 'compose invalido';
}

/** Crea (en el DESTINO) las carpetas de datos de la version antes de montarlas. */
export async function ensureDataDirs(host: HostRef, dataDir: string): Promise<void> {
  await runShell(host, `mkdir -p "${dataDir}/alf-data" "${dataDir}/pg-data"`);
}

/** Escribe y levanta el stack del hop. */
export async function provisionCompose(
  request: ComposeRequest,
  workDir: string,
  host: HostRef,
): Promise<{ file: string; started: boolean; detail: string }> {
  const file = await writeCompose(request, workDir);
  // El compose se envia por STDIN (`-f -`): asi funciona igual en local y en el DESTINO remoto, donde la
  // ruta local no existe.
  const result = await runShellWithInput(host, 'docker compose -f - up -d --remove-orphans', renderCompose(request));
  if (result.exitCode !== 0) {
    throw new Error(`docker compose up fallido (exit=${result.exitCode}): ${result.stderr}`);
  }
  return { file, started: true, detail: result.stdout.trim() };
}

export function projectToComposeRequest(
  project: ProjectConfig,
  acsVersion: string,
  withShare = false,
  memory?: AlfrescoMemory,
  dataDir?: string,
): ComposeRequest {
  return {
    projectName: project.project,
    acsVersion,
    edition: project.target.edition ?? 'CE',
    deployment: project.target.deployment ?? 'compose',
    database: project.target.database,
    search: project.target.search,
    withShare,
    memory,
    dataDir,
  };
}
