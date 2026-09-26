/**
 * Provision del destino en Docker Compose (E7): genera el compose de cada hop y levanta el stack.
 * El upgrade real del esquema lo ejecuta el propio ACS al arrancar; el migrador solo orquesta.
 *
 * Auto-skip con `MIGRATOR_DST_PROVISION`: auto (defecto, detecta stack en ejecucion),
 * managed (provisiona siempre) o external (nunca provisiona).
 *
 * Portado de ComposeFileBuilder/ComposeTargetProvisioner/ProvisionTargetStep.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import yaml from 'js-yaml';
import { dataDir } from './data-dir.js';
import { runShell, runShellWithInput, type ExecResult, type HostRef } from '../infra/exec.js';
import { memLimitForCompose, type AlfrescoMemory } from './memory.js';
import { compareTuple, parseVersion } from './versions.js';
import type { ProjectConfig } from './project-config.js';
import {
  extensionDockerfile,
  proxyConfig,
  repositoryJavaOpts,
  stackInfraServices,
  shareImage,
  transformImage,
  type FinalStack,
} from './final-stack.js';

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
  /**
   * Montar la BD como BIND en `<dataDir>/pg-data`. Por defecto `false` (volumen con nombre): en Docker
   * Desktop (macOS) un bind para PGDATA suele fallar por permisos ("could not change permissions").
   */
  pgBind?: boolean;
  /** Imagen EXACTA del repositorio (si se aporta, manda sobre `edition`+`acsVersion`). */
  acsImage?: string;
  /** Stack de la version FINAL (Share, transform, proxy, extensiones). Solo en el ultimo hop. */
  stack?: FinalStack;
  /** JAR de modelos de contenido EN EL DESTINO: se monta en TODOS los hops. */
  modelsJar?: string;
}

/** `true` si el tag de la imagen es PRE-RELEASE (Alpha/Beta/RC/SNAPSHOT/M): no usar en migracion. */
export function isPrereleaseImage(image: string): boolean {
  const tag = image.includes(':') ? image.slice(image.lastIndexOf(':') + 1) : '';
  return /(^|[-._])(a\d+|alpha|beta|rc\d*|snapshot|m\d+|milestone|preview|dev|nightly)/i.test(tag);
}

const POSTGRES_IMAGE = 'postgres:15';
/** Cabecera de los compose GENERADOS: solo esos se pueden regenerar (el del operador nunca se toca). */
export const GENERATED_MARKER = '# generado por alfresco-migrator (se regenera; no editar a mano)';
// Los tags de ActiveMQ NO son "genericos": en el registro solo existen los -jre17-rockylinux8.
const ACTIVEMQ_5 = 'alfresco/alfresco-activemq:5.18.7-jre17-rockylinux8';
const ACTIVEMQ_6 = 'alfresco/alfresco-activemq:6.2.9-jre17-rockylinux8';

/** ActiveMQ segun la version de ACS destino (26.x usa la serie 6.x). */
const activemqImage = (acsVersion: string): string => ((parseVersion(acsVersion)[0] ?? 0) >= 26 ? ACTIVEMQ_6 : ACTIVEMQ_5);

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

/** Ultimo parche conocido por version (`data/images.yaml`); vacio si no hay fichero. */
function latestPatches(): Record<string, string> {
  try {
    const doc = yaml.load(readFileSync(path.join(dataDir(), 'images.yaml'), 'utf8')) as { repositoryCommunity?: Record<string, string> };
    return doc.repositoryCommunity ?? {};
  } catch {
    return {};
  }
}

export const repositoryImage = (edition: string, version: string): string => {
  const repository = edition === 'EE' ? 'quay.io/alfresco/alfresco-content-repository' : 'alfresco/alfresco-content-repository-community';
  // Los tags no son genericos: `7.4`/`25.3`/`26.2` NO existen; hay que usar el patch exacto. Sin patch en la
  // version: el ULTIMO parche conocido (data/images.yaml, solo CE) o `.0`.
  if (version.split('.').length >= 3) return `${repository}:${version}`;
  const known = edition === 'EE' ? undefined : latestPatches()[version];
  return `${repository}:${known ?? `${version}.0`}`;
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
  lines.push(GENERATED_MARKER);
  lines.push(`name: ${composeProjectName(request.projectName)}`);
  lines.push('services:');
  lines.push('  postgres:');
  lines.push(`    image: ${dbImage(db?.engine)}`);
  lines.push('    environment:');
  lines.push(`      POSTGRES_DB: ${db?.name ?? 'alfresco'}`);
  lines.push(`      POSTGRES_USER: ${user}`);
  lines.push('      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}');
  lines.push('    volumes:');
  lines.push(
    request.dataDir && request.pgBind
      ? `      - ${request.dataDir}/pg-data:/var/lib/postgresql/data`
      : '      - alfresco-db:/var/lib/postgresql/data',
  );
  lines.push('  activemq:');
  lines.push(`    image: ${activemqImage(request.acsVersion)}`);
  lines.push('    environment:');
  lines.push('      ACTIVEMQ_ADMIN_LOGIN: ${ACTIVEMQ_ADMIN_LOGIN}');
  lines.push('      ACTIVEMQ_ADMIN_PASSWORD: ${ACTIVEMQ_ADMIN_PASSWORD}');
  lines.push('    ports:');
  lines.push('      - "8161:8161"');
  lines.push('  search:');
  lines.push(`    image: ${searchImage(search)}`);
  lines.push('    environment:');
  lines.push('      discovery.type: single-node');
  lines.push(search === 'ELASTICSEARCH' ? '      xpack.security.enabled: "false"' : '      plugins.security.disabled: "true"');
  const stack = request.stack;
  const repoBase = request.acsImage ?? repositoryImage(request.edition, request.acsVersion);
  lines.push('  alfresco:');
  if (stack?.extensions?.repo) {
    // Imagen DERIVADA con las extensiones migradas (se construye en el DESTINO desde su carpeta).
    lines.push(`    image: ${composeProjectName(request.projectName)}-repo-ext:${slug(request.acsVersion)}`);
    pushBuild(lines, stack.extensions.repo, extensionDockerfile(repoBase, 'alfresco'));
  } else {
    lines.push(`    image: ${repoBase}`);
  }
  lines.push(`    mem_limit: ${request.memory ? memLimitForCompose(request.memory) : '2560m'}`);
  lines.push('    depends_on:');
  lines.push('      - postgres');
  lines.push('      - activemq');
  lines.push('      - search');
  lines.push('    environment:');
  const repoOpts = [request.memory ? request.memory.javaOpts : '-Xms1g -Xmx2g', ...repositoryJavaOpts(stack, request.acsVersion)];
  lines.push(`      JAVA_OPTS: "${repoOpts.join(' ')}"`);
  lines.push(`      JAVA_TOOL_OPTIONS: "${keystoreJavaOpts()}"`);
  lines.push(`      DB_URL: ${jdbcUrl(db, 'postgres')}`);
  lines.push(`      DB_USERNAME: ${user}`);
  lines.push('      DB_PASSWORD: ${POSTGRES_PASSWORD}');
  lines.push('      ACTIVEMQ_ADMIN_LOGIN: ${ACTIVEMQ_ADMIN_LOGIN}');
  lines.push('      ACTIVEMQ_ADMIN_PASSWORD: ${ACTIVEMQ_ADMIN_PASSWORD}');
  lines.push('      ELASTICSEARCH_HOSTS: http://search:9200');
  // Con proxy, el 8080 lo publica el proxy (entrada unica /alfresco + /share).
  if (!stack?.proxy) {
    lines.push('    ports:');
    lines.push('      - "8080:8080"');
  }
  lines.push('    volumes:');
  lines.push(request.dataDir ? `      - ${request.dataDir}/alf-data:/usr/local/tomcat/alf_data` : '      - alfresco-content:/usr/local/tomcat/alf_data');
  if (request.dataDir) {
    // La imagen 7.4 arranca con `alfresco-global.properties` VACIO: los DB_* de entorno no bastan y
    // Spring falla al crear los beans de BD. Se monta un fichero generado con la config de BD.
    lines.push(`      - ${request.dataDir}/config/alfresco-global.properties:/usr/local/tomcat/shared/classes/alfresco-global.properties:ro`);
  }
  if (request.modelsJar) {
    // Modelos de contenido del origen (independientes del codigo): mismos tipos/aspectos en cada hop.
    lines.push(`      - ${request.modelsJar}:/usr/local/tomcat/webapps/alfresco/WEB-INF/lib/${path.posix.basename(request.modelsJar)}:ro`);
  }
  if (stack?.share || request.withShare) {
    const host = stack?.publicHost ?? 'localhost';
    const base = shareImage(stack ?? {}, request.acsVersion, request.edition);
    lines.push('  share:');
    if (stack?.extensions?.share) {
      lines.push(`    image: ${composeProjectName(request.projectName)}-share-ext:${slug(request.acsVersion)}`);
      pushBuild(lines, stack.extensions.share, extensionDockerfile(base, 'share'));
    } else {
      lines.push(`    image: ${base}`);
    }
    lines.push('    mem_limit: 1g');
    lines.push('    depends_on:');
    lines.push('      - alfresco');
    lines.push('    environment:');
    lines.push('      REPO_HOST: alfresco');
    lines.push('      REPO_PORT: "8080"');
    lines.push(`      CSRF_FILTER_ORIGIN: http://${host}:8080`);
    lines.push(`      CSRF_FILTER_REFERER: http://${host}:8080/share/.*`);
    lines.push(`      JAVA_OPTS: "-XX:MinRAMPercentage=50 -XX:MaxRAMPercentage=80 -Dalfresco.host=${host} -Dalfresco.port=8080 -Dalfresco.context=alfresco -Dalfresco.protocol=http"`);
    if (!stack?.proxy) {
      lines.push('    ports:');
      lines.push('      - "8081:8080"');
    }
  }
  if (stack?.transform) {
    lines.push('  transform-core-aio:');
    lines.push(`    image: ${transformImage(stack, request.acsVersion)}`);
    lines.push('    mem_limit: 1536m');
    lines.push('    environment:');
    lines.push('      JAVA_OPTS: "-XX:MinRAMPercentage=50 -XX:MaxRAMPercentage=80"');
  }
  if (stack?.proxy) {
    lines.push('  proxy:');
    lines.push('    image: nginx:stable-alpine');
    lines.push('    ports:');
    lines.push('      - "8080:8080"');
    lines.push('    volumes:');
    lines.push(`      - ${request.dataDir ?? '.'}/config/nginx.conf:/etc/nginx/nginx.conf:ro`);
  }
  lines.push('volumes:');
  lines.push('  alfresco-db:');
  if (!request.dataDir) {
    lines.push('  alfresco-content:');
  }
  return lines.join('\n') + '\n';
}

/** `build:` con Dockerfile inline (contexto = carpeta de extensiones EN EL DESTINO). */
function pushBuild(lines: string[], context: string, dockerfile: string): void {
  lines.push('    build:');
  lines.push(`      context: ${context}`);
  lines.push('      dockerfile_inline: |');
  for (const line of dockerfile.split('\n')) lines.push(`        ${line}`);
}

export const slug = (version: string): string => version.replace(/[^A-Za-z0-9._-]/g, '-');

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
 * Con `explicit` se para solo ese; si no, el PROPIO stack de la migracion (`own`) y los que parezcan de
 * Alfresco. NUNCA se para un proyecto ajeno por ser el unico en ejecucion (el host puede ser compartido).
 */
export function stopTargets(projects: string[], explicit?: string, own?: string): string[] {
  if (explicit && explicit.trim()) return [explicit.trim()];
  return projects.filter((p) => p === own || /alfresco/i.test(p));
}

/** Para (down) los stacks del DESTINO que ocupan el hop (el propio y los de Alfresco); ver `stopTargets`. */
export async function stopRunningStacks(host: HostRef, own?: string, env: NodeJS.ProcessEnv = process.env): Promise<string[]> {
  const listed = await runShell(host, 'docker compose ls -q');
  const projects = listed.exitCode === 0 ? listed.stdout.split('\n').map((s) => s.trim()).filter(Boolean) : [];
  const stopped: string[] = [];
  for (const project of stopTargets(projects, env.MIGRATOR_DST_COMPOSE_PROJECT, own)) {
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

/** Registro de una imagen (host) cuando no es Docker Hub (p.ej. `quay.io`); `undefined` si es Docker Hub. */
export function imageRegistry(image: string): string | undefined {
  const first = image.split('/')[0] ?? '';
  return first.includes('.') || first.includes(':') ? first : undefined;
}

/** Login en el registro del DESTINO (EE/quay.io). El password va por STDIN (no se expone ni en el comando). */
export async function registryLogin(host: HostRef, registry: string, user: string, password: string): Promise<void> {
  const result = await runShellWithInput(host, `docker login ${registry} -u '${user}' --password-stdin`, password);
  if (result.exitCode !== 0) {
    throw new Error(`docker login ${registry} fallido: ${result.stderr.trim() || result.stdout.trim()}`);
  }
}

/**
 * `true` si el DESTINO ya tiene la BD como bind en `<dataDir>/pg-data` (p.ej. el compose del hop previo):
 * los hops siguientes deben montar LA MISMA carpeta, o arrancarian sobre un volumen vacio.
 */
export async function hasPgDataBind(host: HostRef, dataDir: string): Promise<boolean> {
  return (await runShell(host, `test -d "${dataDir}/pg-data"`)).exitCode === 0;
}

/** Crea (en el DESTINO) las carpetas de datos de la version antes de montarlas. */
export async function ensureDataDirs(host: HostRef, dataDir: string, pgBind = false): Promise<void> {
  const dirs = pgBind ? `"${dataDir}/alf-data" "${dataDir}/pg-data"` : `"${dataDir}/alf-data"`;
  await runShell(host, `mkdir -p ${dirs}`);
}

/**
 * Secretos del stack del hop (`.migrator/provision/stack.env`), generados una vez y reutilizados: el
 * compose los referencia como `${POSTGRES_PASSWORD}` / `${ACTIVEMQ_ADMIN_*}` y sin ellos Postgres no
 * arranca. NO se exponen en la salida de la tool (no viajan al LLM).
 */
export async function ensureStackSecrets(workDir: string): Promise<Record<string, string>> {
  const file = path.join(workDir, 'stack.env');
  let text = '';
  try {
    text = await readFile(file, 'utf8');
  } catch {
    text = '';
  }
  const current: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const index = line.indexOf('=');
    if (index > 0) current[line.slice(0, index).trim()] = line.slice(index + 1).trim();
  }
  const secrets: Record<string, string> = {
    POSTGRES_PASSWORD: current.POSTGRES_PASSWORD || randomBytes(12).toString('hex'),
    ACTIVEMQ_ADMIN_LOGIN: current.ACTIVEMQ_ADMIN_LOGIN || 'admin',
    ACTIVEMQ_ADMIN_PASSWORD: current.ACTIVEMQ_ADMIN_PASSWORD || randomBytes(12).toString('hex'),
  };
  await mkdir(workDir, { recursive: true });
  await writeFile(file, Object.entries(secrets).map(([key, value]) => `${key}=${value}`).join('\n') + '\n', 'utf8');
  return secrets;
}

/**
 * Keystore de METADATOS por defecto de las imagenes Docker de ACS (los valores publicos del compose
 * oficial y del ORIGEN (7.1)). Deben ser LOS MISMOS que en el origen: las propiedades cifradas de la
 * BD restaurada se descifran con este keystore. Sin ellos la imagen abre su keystore JCEKS como PKCS12 y
 * Alfresco no arranca. Se ponen en `alfresco-global.properties` y, en los compose generados, tambien como
 * propiedades JVM (`JAVA_TOOL_OPTIONS`), que es la via que documenta Alfresco.
 */
export const DEFAULT_KEYSTORE: Record<string, string> = {
  'encryption.keystore.type': 'JCEKS',
  'encryption.cipherAlgorithm': 'DESede/CBC/PKCS5Padding',
  'encryption.keyAlgorithm': 'DESede',
  'encryption.keystore.location': '/usr/local/tomcat/shared/classes/alfresco/extension/keystore/keystore',
  'metadata-keystore.password': 'mp6yc0UD9e',
  'metadata-keystore.aliases': 'metadata',
  'metadata-keystore.metadata.password': 'oKIWzVdEdA',
  'metadata-keystore.metadata.algorithm': 'DESede',
};

const keystoreJavaOpts = (): string =>
  Object.entries(DEFAULT_KEYSTORE).map(([key, value]) => `-D${key}=${value}`).join(' ');

/**
 * Contenido de `alfresco-global.properties` para el hop. La imagen 7.4 arranca con el fichero VACIO y los
 * `DB_*` de entorno no se aplican; sin esto Spring falla creando los beans de BD. El resto (search,
 * activemq) sigue por entorno en el compose.
 */
export function globalProperties(request: ComposeRequest, secrets: Record<string, string>): string {
  const name = request.database?.name ?? 'alfresco';
  const user = request.database?.user ?? 'alfresco';
  return [
    'db.driver=org.postgresql.Driver',
    `db.url=jdbc:postgresql://postgres:5432/${name}`,
    `db.username=${user}`,
    `db.password=${secrets.POSTGRES_PASSWORD ?? ''}`,
    'dir.root=/usr/local/tomcat/alf_data',
    ...Object.entries(DEFAULT_KEYSTORE).map(([key, value]) => `${key}=${value}`),
    '',
  ].join('\n');
}

/** Escribe (en el DESTINO) el `alfresco-global.properties` del hop antes de levantar. */
export async function writeStackConfig(host: HostRef, dataDir: string, content: string): Promise<void> {
  const b64 = Buffer.from(content, 'utf8').toString('base64');
  await runShell(
    host,
    `mkdir -p "${dataDir}/config" && printf '%s' '${b64}' | base64 -d > "${dataDir}/config/alfresco-global.properties"`,
  );
}

/** RAM asignada a Docker en el host (bytes); `undefined` si no se puede detectar. */
export async function dockerMemTotal(host: HostRef): Promise<number | undefined> {
  try {
    const result = await runShell(host, `docker info --format '{{.MemTotal}}'`);
    const bytes = Number.parseInt(result.stdout.trim(), 10);
    return result.exitCode === 0 && Number.isFinite(bytes) && bytes > 0 ? bytes : undefined;
  } catch {
    return undefined;
  }
}

/** Prefijo de entorno con los secretos y un DOCKER_CONFIG limpio (evita el keychain de macOS por SSH). */
export function composeEnvPrefix(secrets: Record<string, string>): string {
  const env = Object.entries(secrets).map(([key, value]) => `${key}='${value}'`).join(' ');
  const dockerConfig = 'DOCKER_CONFIG=$(d=$(mktemp -d) && printf "{}" > "$d/config.json" && echo "$d")';
  return `${dockerConfig} ${env}`;
}

/**
 * Comandos listos para COPIAR Y EJECUTAR en el DESTINO, para cuando no hay SSH o el usuario necesita
 * `sudo`. El compose viaja en base64 (no depende de ficheros locales).
 */
export function manualCommands(request: ComposeRequest, dstDir?: string): string[] {
  const content = renderCompose(request);
  const b64 = Buffer.from(content, 'utf8').toString('base64');
  const file = `/tmp/docker-compose-${slug(request.acsVersion)}.yml`;
  const project = slug(request.projectName);
  const envFile = `/tmp/${project}.env`;
  const globalFile = `/tmp/${project}-global.properties`;
  const commands: string[] = [];
  // Los secretos/config NO se incluyen: se copian del estado local (no viajan al LLM).
  commands.push(`scp .migrator/provision/stack.env <usuario>@<host>:${envFile}`);
  if (dstDir) {
    commands.push(`scp .migrator/provision/${project}-global.properties <usuario>@<host>:${globalFile}`);
    commands.push(`sudo mkdir -p "${dstDir}/alf-data" "${dstDir}/config"${request.pgBind ? ` "${dstDir}/pg-data"` : ''}`);
  }
  commands.push(`printf '%s' '${b64}' | base64 -d | sudo tee ${file} >/dev/null`);
  if (dstDir) commands.push(`sudo cp ${globalFile} "${dstDir}/config/alfresco-global.properties"`);
  commands.push(`sudo docker compose -p "${composeProjectName(request.projectName)}" down --remove-orphans`);
  commands.push(
    `sudo DOCKER_CONFIG=$(d=$(mktemp -d) && printf '{}' > "$d/config.json" && echo "$d") docker compose --env-file ${envFile} -p "${composeProjectName(request.projectName)}" -f ${file} up -d --remove-orphans`,
  );
  return commands;
}

/**
 * Comandos manuales para un compose EXISTENTE en el DESTINO (aportado por el operador con
 * `target.composeFile`): no se genera ni copia nada; se usa el fichero tal cual. Sin `-p` para respetar
 * el nombre de proyecto del propio compose (su `name:` o el directorio), sin tocar otros stacks.
 */
export function manualCommandsForFile(composeFile: string): string[] {
  return [
    `sudo docker compose -f "${composeFile}" down --remove-orphans`,
    `sudo docker compose -f "${composeFile}" up -d ${INFRA_SERVICES}`,
  ];
}

/** Valida un compose EXISTENTE en el DESTINO (sin generarlo): `docker compose -f <file> config -q`. */
export async function validateRemoteCompose(host: HostRef, file: string): Promise<string | undefined> {
  const result = await runShell(host, `docker compose -f "${file}" config -q`);
  return result.exitCode === 0 ? undefined : result.stderr.trim() || result.stdout.trim() || 'compose invalido';
}

/** Para (down) el stack del compose EXISTENTE en el DESTINO (respeta su nombre de proyecto). */
export async function downExternalCompose(host: HostRef, file: string): Promise<boolean> {
  const result = await runShell(host, `docker compose -f "${file}" down --remove-orphans`);
  return result.exitCode === 0;
}

/** Levanta SOLO la infraestructura del compose EXISTENTE (Alfresco se arranca tras el restore). */
export async function upExternalInfra(host: HostRef, file: string): Promise<string> {
  const result = await runShell(host, `docker compose -f "${file}" up -d ${INFRA_SERVICES}`);
  if (result.exitCode !== 0) {
    throw new Error(`docker compose up (infra, compose del operador) fallido (exit=${result.exitCode}): ${result.stderr}`);
  }
  return result.stdout.trim();
}

/**
 * Nombre de proyecto docker compose VALIDO: solo `[a-z0-9_-]` (los puntos de `acme-7.1.0` NO valen).
 */
export const composeProjectName = (name: string): string => {
  const slugged = name
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .replace(/-+$/, '')
    .slice(0, 63);
  return slugged || 'alfresco';
};

/** Imagenes que referencia el compose del hop (para preflight de existencia en el registro). */
export function composeImages(request: ComposeRequest): string[] {
  const images = [dbImage(request.database?.engine), activemqImage(request.acsVersion), searchImage(request.search?.engine)];
  const stack = request.stack;
  if (stack?.share || request.withShare) images.push(shareImage(stack ?? {}, request.acsVersion, request.edition));
  if (stack?.transform) images.push(transformImage(stack, request.acsVersion));
  if (stack?.proxy) images.push('nginx:stable-alpine');
  // El repositorio va el ULTIMO (provision-hop lo usa para el control de pre-release).
  images.push(request.acsImage ?? repositoryImage(request.edition, request.acsVersion));
  return images;
}

/** Imagenes que NO existen en el registro (preflight con `docker manifest inspect` en el DESTINO). */
export async function missingImages(host: HostRef, images: string[]): Promise<string[]> {
  const missing: string[] = [];
  for (const image of images) {
    const result = await runShell(host, `docker manifest inspect ${image} >/dev/null 2>&1`);
    if (result.exitCode !== 0) missing.push(image);
  }
  return missing;
}

/** Servicios de INFRAESTRUCTURA (no Alfresco): se levantan primero, antes del restore. */
export const INFRA_SERVICES = 'postgres activemq search';

/**
 * Escribe el compose en el DESTINO (para poder arrancar Alfresco mas tarde con `-f <fichero>`).
 * NUNCA se sobrescribe un compose ajeno (puede ser el validado por el operador): solo si no existe, si
 * lleva la cabecera GENERATED_MARKER o si es IDENTICO a la copia local que el migrator genero antes
 * (`previous`, composes anteriores a la cabecera).
 */
export async function writeComposeRemote(host: HostRef, remoteFile: string, content: string, previous?: string): Promise<void> {
  const b64 = Buffer.from(content, 'utf8').toString('base64');
  const conditions = [`[ ! -f "${remoteFile}" ]`, `head -1 "${remoteFile}" | grep -qF '${GENERATED_MARKER}'`];
  if (previous) {
    const prevB64 = Buffer.from(previous, 'utf8').toString('base64');
    // `cmp -s` falla en cerrado (sin cmp o con diferencias => no se sobrescribe).
    conditions.push(`{ t=$(mktemp) && printf '%s' '${prevB64}' | base64 -d > "$t" && cmp -s "$t" "${remoteFile}"; r=$?; rm -f "$t"; [ $r -eq 0 ]; }`);
  }
  await runShell(
    host,
    `mkdir -p "$(dirname "${remoteFile}")" && if ${conditions.join(' || ')}; then printf '%s' '${b64}' | base64 -d > "${remoteFile}"; fi`,
  );
}

/** Escribe y levanta el stack del hop. */
export async function provisionCompose(
  request: ComposeRequest,
  workDir: string,
  host: HostRef,
): Promise<{ file: string; started: boolean; detail: string }> {
  // Copia local de la generacion anterior (si la hay): identifica un compose remoto como generado.
  const previous = await readFile(path.join(workDir, `docker-compose-${slug(request.acsVersion)}.yml`), 'utf8').catch(() => undefined);
  const file = await writeCompose(request, workDir);
  const secrets = await ensureStackSecrets(workDir);
  const content = renderCompose(request);
  // ORDEN NATURAL: se levanta SOLO la infraestructura (postgres/activemq/search). Alfresco se arranca
  // despues del restore (paso `schema-upgrade`), para que no cree una raiz espuria sobre una BD vacia.
  // Si hay `dataDir`, el compose queda escrito en el DESTINO para poder arrancar Alfresco luego con -f.
  let composeArg = '-f -';
  if (request.dataDir && request.stack?.proxy) {
    const conf = Buffer.from(proxyConfig(!!request.stack.share), 'utf8').toString('base64');
    await runShell(host, `mkdir -p "${request.dataDir}/config" && printf '%s' '${conf}' | base64 -d > "${request.dataDir}/config/nginx.conf"`);
  }
  if (request.dataDir) {
    const remote = hopComposeFile(request.dataDir, request.acsVersion);
    await writeComposeRemote(host, remote, content, previous);
    composeArg = `-f "${remote}"`;
  }
  const services = [INFRA_SERVICES, ...stackInfraServices(request.stack)].join(' ');
  const command = `${composeEnvPrefix(secrets)} docker compose ${composeArg} -p "${composeProjectName(request.projectName)}" up -d ${services}`;
  const result = await runShellWithInput(host, command, request.dataDir ? '' : content);
  if (result.exitCode !== 0) {
    throw new Error(`docker compose up (infra) fallido (exit=${result.exitCode}): ${result.stderr}`);
  }
  // Con `dataDir` Alfresco lee la contraseña de alfresco-global.properties (secreto del stack): la BD
  // conserva la de su inicializacion, asi que se alinea (idempotente).
  if (request.dataDir) {
    const composeCmd = `${composeEnvPrefix(secrets)} docker compose ${composeArg} -p "${composeProjectName(request.projectName)}"`;
    await alignDbPassword(host, composeCmd, request.database?.user ?? 'alfresco', secrets.POSTGRES_PASSWORD ?? '');
  }
  return { file, started: true, detail: result.stdout.trim() };
}

/**
 * Alinea la contraseña del rol de BD con el secreto del stack. `POSTGRES_PASSWORD` solo se aplica al
 * INICIALIZAR el cluster: si `pg-data` se creo con otra (compose del operador, un hop previo), Alfresco
 * falla con "password authentication failed". Dentro del contenedor el socket local es `trust`, asi que
 * se fija con `ALTER ROLE` sin conocer la anterior. Espera a que Postgres acepte conexiones.
 */
export async function alignDbPassword(
  host: HostRef,
  composeCmd: string,
  user: string,
  password: string,
  attempts = 30,
): Promise<void> {
  if (!/^[A-Za-z0-9_]+$/.test(user) || password.includes("'")) {
    throw new Error('usuario/contraseña de BD con caracteres no soportados para ALTER ROLE');
  }
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const ready = await runShell(host, `${composeCmd} exec -T postgres pg_isready -U ${user}`);
    if (ready.exitCode === 0) break;
    if (attempt === attempts) throw new Error('Postgres del DESTINO no acepta conexiones');
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  const sql = `ALTER ROLE ${user} WITH PASSWORD '${password}'`;
  const result = await runShellWithInput(host, `${composeCmd} exec -T postgres psql -v ON_ERROR_STOP=1 -U ${user} -d postgres`, sql);
  if (result.exitCode !== 0) {
    throw new Error(`no se pudo alinear la contraseña de BD: ${result.stderr.trim() || result.stdout.trim()}`);
  }
}

/** Compose del hop EN EL DESTINO (directorio de version): `<dataDir>/compose/docker-compose-<hop>.yml`. */
export const hopComposeFile = (dataDir: string, version: string): string =>
  `${dataDir}/compose/docker-compose-${slug(version)}.yml`;

/** Version del tag de una imagen (`repo:7.4.2` -> `7.4.2`); `undefined` si el tag no es una version. */
export const acsImageVersion = (image: string): string | undefined => {
  const tag = image.includes(':') ? image.slice(image.lastIndexOf(':') + 1) : '';
  return /^\d+\.\d+/.test(tag) ? tag : undefined;
};

/** Mismo mayor.minor (7.4 == 7.4.2). */
const sameMinorVersion = (a: string, b: string): boolean =>
  compareTuple(parseVersion(a).slice(0, 2), parseVersion(b).slice(0, 2)) === 0;

export function projectToComposeRequest(
  project: ProjectConfig,
  acsVersion: string,
  withShare = false,
  memory?: AlfrescoMemory,
  dataDir?: string,
  pgBind = false,
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
    pgBind,
    // El stack de la version FINAL solo en el ultimo hop (los intermedios: repositorio + infra).
    ...(project.target.stack && sameMinorVersion(acsVersion, project.target.version) ? { stack: project.target.stack } : {}),
    // `target.acsImage` aplica al hop cuya version casa con el TAG de la imagen (7.4.2 -> hop 7.4); si el
    // tag no es una version, a la version FINAL. Los demas hops usan la suya (<version>.0).
    ...(project.target.acsImage && sameMinorVersion(acsVersion, acsImageVersion(project.target.acsImage) ?? project.target.version)
      ? { acsImage: project.target.acsImage }
      : {}),
  };
}
