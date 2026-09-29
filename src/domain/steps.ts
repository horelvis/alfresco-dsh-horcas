/**
 * Catalogo de PASOS de migracion ejecutables sobre el DESTINO (nunca el origen).
 *
 * No es un pipeline fijo: el agente razona que pasos aplicar, en que orden y con que parametros, y
 * reutiliza la experiencia del ensayo. Cada paso es idempotente y se registra en checkpoints.
 *
 * Overrides de entorno: `MIGRATOR_DB_DUMP_CMD` ({out}), `MIGRATOR_DB_RESTORE_CMD`
 * ({in}), `MIGRATOR_REINDEX_CMD` ({prefixesFile},{dbUrl}), `MIGRATOR_DST_PROVISION`.
 */
import { mkdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { HostRef } from '../infra/exec.js';
import { runShell, runShellWithInput, substitute, type ExecResult } from '../infra/exec.js';
import type { ProjectConfig } from '../domain/project-config.js';
import { planContentCopy } from './content-copy.js';
import { resolveContentStorePath } from './content-store.js';
import { discoverRest } from './assessment.js';
import { sameMinor } from './hops.js';
import { requireSupportedUpgradePath } from './upgrade-paths.js';
import {
  BATCH_INDEXER_SERVICE,
  composeEnvPrefix,
  composeImages,
  composeProjectName,
  dockerMemTotal,
  ensureDataDirs,
  ensureOperatorStackEnv,
  ensureStackSecrets,
  globalProperties,
  hasPgDataBind,
  hopComposeFile,
  imageRegistry,
  isPrereleaseImage,
  missingImages,
  projectToComposeRequest,
  provisionCompose,
  registryLogin,
  renderCompose,
  stopRunningStacks,
  validateCompose,
  writeStackConfig,
} from './provision.js';
import { computeAlfrescoMemory } from './memory.js';
import { modelsCoverage, NAMESPACES_IN_USE_SQL, validateModelsJar, type ContentModel, type ModelsCoverage } from './models.js';
import { isSearchCommunity, missingPrefixes, prefixMapFromJson, prefixesFromModels, resolveReindexStrategy, searchCommunityReindexScript } from './reindex.js';
import { connectSource, dbConfigFromYaml, queryRows } from '../infra/pg.js';
import { recordEvidence } from './evidence.js';
import { stackForVersion, stackLateServices } from './final-stack.js';
import { errorExcerpt, evaluateSmoke, evaluateUpgradeLog } from './schema-upgrade.js';

/** Ultimas lineas no vacias del log (acotadas) para el detalle de un fallo sin marcador conocido. */
const lastLines = (log: string, n = 8): string =>
  log.split('\n').map((l) => l.trim()).filter(Boolean).slice(-n).join(' | ').slice(-1500);
import { describeError } from '../infra/errors.js';

export interface StepContext {
  project: ProjectConfig;
  destination: HostRef;
  /** Host que toca el ORIGEN (JShell/JDBC local por defecto); el destino va por `destination`. */
  source?: HostRef;
  state: string;
  runId: string;
  dryRun: boolean;
  /**
   * Version del hop que toca (la calcula `migrator_run_steps` desde `.migrator/hops.jsonl`). En una ruta
   * de un solo hop, la version final.
   */
  hop?: string;
}

export interface StepOutcome {
  step: string;
  ok: boolean;
  detail: string;
  command?: string;
  skipped?: boolean;
}

export interface StepDefinition {
  id: string;
  description: string;
  /** Linea CORTA para la aprobacion humana (una frase, en claro). El detalle vive en `description`. */
  short: string;
  /** Escribe en el destino (true) o es solo lectura/verificacion (false). */
  writes: boolean;
  run(ctx: StepContext, params: Record<string, unknown>): Promise<StepOutcome>;
}

const ok = (step: string, detail: string, command?: string): StepOutcome => ({ step, ok: true, detail, command });

/**
 * Credenciales REST del DESTINO para probes curl (`-u "user:pass"`). El usuario puede heredar del
 * origen, pero la CONTRASEÑA es obligatoria: si falta, el paso FALLA sin intentar `admin`
 * (un default silencioso podria "verificar" contra un destino con contrasena por defecto).
 */
export function dstCreds(): string {
  const user = process.env.MIGRATOR_DST_USER ?? process.env.MIGRATOR_SRC_USER;
  const password = process.env.MIGRATOR_DST_PASSWORD ?? process.env.MIGRATOR_SRC_PASSWORD;
  if (!user || !password) {
    throw new Error('faltan MIGRATOR_DST_USER/MIGRATOR_DST_PASSWORD (o SRC_*) para verificar el destino: define credenciales en el .env');
  }
  return `${user}:${password}`;
}

const skipped = (step: string, detail: string): StepOutcome => ({ step, ok: true, detail, skipped: true });
const fail = (step: string, detail: string, command?: string): StepOutcome => ({ step, ok: false, detail, command });

function requireResult(step: string, result: ExecResult): StepOutcome {
  const detail = result.exitCode === 0 ? result.stdout.trim() : result.stderr.trim();
  return result.exitCode === 0 ? ok(step, detail, result.command) : fail(step, detail, result.command);
}

function destinationDbUrl(project: ProjectConfig): string {
  const db = project.target.database;
  return `postgresql://${db?.user ?? 'alfresco'}@${db?.host ?? 'localhost'}:${db?.port ?? 5432}/${db?.name ?? 'alfresco'}`;
}

/** `preflight-target`: comprueba conectividad y runtime en el destino (SSH/docker/compose). */
const preflightTarget: StepDefinition = {
  id: 'preflight-target',
  short: 'Comprueba conexion y Docker en el DESTINO',
  description: 'Conectividad y runtime del destino (ssh, docker, docker compose).',
  writes: false,
  async run(ctx) {
    if (ctx.destination.name === 'local') {
      return skipped('preflight-target', 'destino local');
    }
    const runtime = await runShell(ctx.destination, 'docker version --format "{{.Server.Version}}" && docker compose version --short');
    if (runtime.exitCode !== 0) {
      return fail('preflight-target', runtime.stderr.trim() || 'docker no disponible en el destino');
    }
    const [docker, compose] = runtime.stdout.trim().split('\n');
    // La version de ACS se LEE del repositorio (discovery): Docker/compose NO son la version de ACS.
    const baseUrl = process.env.MIGRATOR_DST_BASE_URL ?? ctx.project.target.baseUrl;
    const detected = baseUrl
      ? await discoverRest(
          baseUrl,
          process.env.MIGRATOR_DST_USER ?? process.env.MIGRATOR_SRC_USER,
          process.env.MIGRATOR_DST_PASSWORD ?? process.env.MIGRATOR_SRC_PASSWORD,
        )
      : undefined;
    return ok(
      'preflight-target',
      `docker=${docker ?? '?'} compose=${compose ?? '?'} acs=${detected?.version ?? 'no detectado'} (docker NO es la version de ACS)`,
    );
  },
};

/** `backup-source-db`: dump de la BD de ORIGEN (lectura del origen; escribe solo el fichero de trabajo). */
const backupSourceDb: StepDefinition = {
  id: 'backup-source-db',
  short: 'Copia de seguridad de la BD del ORIGEN (solo lectura)',
  description: 'Dump logico de la BD del origen a un fichero de trabajo (D2). El origen solo se lee.',
  writes: false,
  async run(ctx, params) {
    const out = String(params.outFile ?? `${ctx.state}/${ctx.runId}/db.dump`);
    const override = process.env.MIGRATOR_DB_DUMP_CMD;
    if (ctx.dryRun) {
      return skipped('backup-source-db', `dry-run: dump a ${out}`);
    }
    if (!override) {
      return skipped('backup-source-db', 'sin MIGRATOR_DB_DUMP_CMD (BD interna al contenedor)');
    }
    // El dump se escribe primero en un fichero de trabajo local (fs del plugin, no sandbox).
    await mkdir(path.dirname(out), { recursive: true });
    const outcome = requireResult('backup-source-db', await runShell(ctx.source ?? { name: 'local' }, substitute(override, { out })));
    if (!outcome.ok) return outcome;
    // Un checkpoint OK con dump vacio/ausente rompe el restore: se comprueba el artefacto.
    try {
      const info = await stat(out);
      if (!info.isFile() || info.size === 0) return fail('backup-source-db', `dump vacio en ${out}`);
    } catch {
      return fail('backup-source-db', `no se creo el dump ${out}`);
    }
    // El directorio de VERSION del DESTINO guarda la copia de la BBDD: <dstDir>/db/<name>.dump
    const dstDir = ctx.project.target.dataDir ?? process.env.MIGRATOR_DST_DIR;
    if (dstDir && ctx.destination.name !== 'local') {
      const remote = `${dstDir}/db/${ctx.project.target.database?.name ?? 'alfresco'}.dump`;
      const copied = await copyDumpToDestination(ctx.destination, out, remote);
      return copied.ok
        ? ok('backup-source-db', `dump ${out} · copia verificada en el DESTINO ${remote} (${copied.bytes} bytes)`)
        : fail('backup-source-db', `dump ${out} creado, pero la copia al DESTINO fallo: ${copied.reason}`);
    }
    return outcome;
  },
};

/**
 * Copia el dump (BINARIO) al DESTINO por stdin como Buffer y verifica que el tamaño remoto coincide: un
 * dump leido como texto se corrompe y pg_restore falla con "could not read from input file".
 */
export async function copyDumpToDestination(
  host: HostRef,
  local: string,
  remote: string,
): Promise<{ ok: true; bytes: number } | { ok: false; reason: string }> {
  let dump: Buffer;
  try {
    dump = await readFile(local);
  } catch (error) {
    return { ok: false, reason: `no se pudo leer ${local}: ${describeError(error)}` };
  }
  const copy = await runShellWithInput(host, `mkdir -p "$(dirname "${remote}")" && cat > "${remote}"`, dump);
  if (copy.exitCode !== 0) return { ok: false, reason: copy.stderr.trim() || `exit=${copy.exitCode}` };
  const size = await runShell(host, `wc -c < "${remote}"`);
  const bytes = Number.parseInt(size.stdout.trim(), 10);
  if (bytes !== dump.length) return { ok: false, reason: `tamaño remoto ${size.stdout.trim() || '?'} != local ${dump.length}` };
  return { ok: true, bytes };
}

/** `copy-content`: replica el content store del origen al destino (rsync/S3/Azure, con delta). */
const copyContent: StepDefinition = {
  id: 'copy-content',
  short: 'Copia el content store del ORIGEN al DESTINO',
  description: 'Copia el content store del origen al destino (rsync/S3/Azure; delta opcional).',
  writes: true,
  async run(ctx, params) {
    const sourceRef = params.sourcePath ? { path: String(params.sourcePath) } : ctx.project.source.contentStore;
    const targetRef = params.targetPath ? { path: String(params.targetPath) } : ctx.project.target.contentStore;
    const host = ctx.source ?? { name: 'local' };
    const source = await resolveContentStorePath(sourceRef, host);

    // dry-run: no resolvemos el mountpoint del destino (evita depender del host) ni ejecutamos.
    if (ctx.dryRun) {
      const label = targetRef?.volume
        ? `${targetRef.volume}${targetRef.path ? `/${targetRef.path}` : ''}`
        : targetRef?.path ?? '';
      return skipped('copy-content', `dry-run: ${source ?? ''} -> ${label}`);
    }
    const target = await resolveContentStorePath(targetRef, ctx.destination);
    if (!source || !target) {
      return fail('copy-content', 'faltan rutas de content store (path o volume)');
    }
    // Guarda NAS/SAN: si origen y destino comparten backing store remoto, la copia se corrompe.
    if (process.env.MIGRATOR_SKIP_MOUNT_GUARD !== 'true') {
      const guard = await mountGuard(source, target);
      if (guard) {
        return fail('copy-content', guard);
      }
    }
    const override = process.env.MIGRATOR_CONTENT_COPY_CMD;
    if (override) {
      return requireResult('copy-content', await runShell(host, substitute(override, { source, target })));
    }
    const sshTarget =
      ctx.destination.name !== 'local' && ctx.destination.host
        ? `${ctx.destination.user ?? 'root'}@${ctx.destination.host}`
        : undefined;
    const plan = planContentCopy(
      { type: 'FS', path: source },
      { type: 'FS', path: target },
      { delta: params.delta === true, sshTarget, sshIdentity: ctx.destination.keyFile },
    );
    return requireResult('copy-content', await runShell(host, plan.command));
  },
};

/** Lee los montajes del host local y del destino y evalua el riesgo de copia. */
async function mountGuard(source: string, target: string): Promise<string | undefined> {
  try {
    const { parseMounts, assessMounts } = await import('./mounts.js');
    const { runShell } = await import('../infra/exec.js');
    const local = parseMounts((await runShell({ name: 'local' }, 'cat /proc/mounts 2>/dev/null')).stdout);
    const assessment = assessMounts(source, target, local, local);
    const blocker = assessment.findings.find((f) => f.severity === 'BLOCKER');
    return blocker ? `Guarda de montaje: ${blocker.detail}` : undefined;
  } catch {
    return undefined; // sin /proc/mounts (p.ej. macOS): no bloquear
  }
}

/** `restore-target-db`: restaura el dump en la BD del DESTINO. */
/**
 * Cobertura de modelos frente al ORIGEN (solo lectura, BD del origen). Devuelve un mensaje de bloqueo si
 * no se puede comprobar (fail-closed).
 */
async function sourceModelsCoverage(ctx: StepContext, models: ContentModel[]): Promise<ModelsCoverage | string> {
  try {
    const client = await connectSource(dbConfigFromYaml(ctx.project.source.database, 'SRC'));
    try {
      const rows = await queryRows(client, NAMESPACES_IN_USE_SQL);
      return modelsCoverage(rows.map((r) => String(r.uri ?? '')), models, ctx.project.target.modelsNotRequired ?? []);
    } finally {
      await client.end();
    }
  } catch (error) {
    return `BLOQUEO: no se pudo comprobar que modelos usa el origen (BD del origen no accesible: ${describeError(error)}); levanta la BD del origen y reintenta.`;
  }
}

/**
 * Motivo de bloqueo si `restore-target-db` se ejecuta fuera del PRIMER hop de la ruta (`undefined` si
 * procede). Para repetir la ruta desde cero hay que reiniciar el progreso de hops (y el destino).
 */
export function restoreHopViolation(ctx: Pick<StepContext, 'hop' | 'project'>): string | undefined {
  const hops = requireSupportedUpgradePath(ctx.project.source.version, ctx.project.target.version);
  const first = hops[0]?.to;
  if (!ctx.hop || !first || hops.length <= 1 || sameMinor(ctx.hop, first)) return undefined;
  return (
    `restore del dump del origen (${ctx.project.source.version}) solo en el PRIMER hop (${first}); el hop pendiente es ${ctx.hop}. ` +
    'Restaurarlo aqui saltaria versiones. Para repetir desde cero hay que reiniciar el progreso de hops (.migrator/hops.jsonl) y el destino: decision humana.'
  );
}

const restoreTargetDb: StepDefinition = {
  id: 'restore-target-db',
  short: 'Restaura la copia de la BD en el DESTINO',
  description:
    'Restaura el dump logico en la BD del destino (D2) con `docker exec pg_restore` dentro del contenedor (el host no necesita pg_restore). Usa el dump del DESTINO si existe; si no, el local. MIGRATOR_DB_RESTORE_CMD es opcional.',
  writes: true,
  async run(ctx, params) {
    const inFile = String(params.inFile ?? `${ctx.state}/${ctx.runId}/db.dump`);
    const override = process.env.MIGRATOR_DB_RESTORE_CMD;
    // El dump es de la version del ORIGEN: solo puede restaurarse en el PRIMER hop. En otro hop arrancaria
    // una version posterior sobre la BD del origen (salto de version no soportado).
    const blocked = restoreHopViolation(ctx);
    if (blocked) return fail('restore-target-db', blocked);
    if (ctx.dryRun) {
      return skipped('restore-target-db', `dry-run: restore de ${inFile}`);
    }
    if (override) {
      const outcome = requireResult('restore-target-db', await runShell(ctx.destination, substitute(override, { in: inFile })));
      return { ...outcome, command: undefined }; // el comando puede llevar credenciales: no se expone
    }
    const db = ctx.project.target.database;
    const user = db?.user ?? 'alfresco';
    const name = db?.name ?? 'alfresco';
    const container = process.env.MIGRATOR_DST_PG_CONTAINER ?? db?.container ?? `${ctx.project.project}-postgres-1`;
    const password = process.env.MIGRATOR_DST_DB_PASSWORD ?? process.env.MIGRATOR_SRC_DB_PASSWORD;
    const envFlag = password ? `-e PGPASSWORD='${password}' ` : '';
    // 1) Si el dump ya esta en el DESTINO (directorio de version), se restaura desde ahi (docker exec < file).
    const dstDir = ctx.project.target.dataDir ?? process.env.MIGRATOR_DST_DIR;
    const remoteCandidates = dstDir ? [`${dstDir}/db/${name}.dump`, `${dstDir}/db.dump`] : [];
    // Si el dump local existe, la copia del DESTINO debe ser identica en tamaño (si no, se re-copia): una
    // copia corrupta de un intento previo no debe restaurarse (el checkpoint de backup puede estar OK).
    const localSize = await stat(inFile).then((info) => info.size).catch(() => undefined);
    if (localSize !== undefined && remoteCandidates[0] && ctx.destination.name !== 'local') {
      const sizes = await runShell(ctx.destination, `wc -c < "${remoteCandidates[0]}" 2>/dev/null`);
      if (Number.parseInt(sizes.stdout.trim(), 10) !== localSize) {
        const copied = await copyDumpToDestination(ctx.destination, inFile, remoteCandidates[0]);
        if (!copied.ok) return fail('restore-target-db', `no se pudo copiar el dump al DESTINO: ${copied.reason}`);
      }
    }
    for (const remote of remoteCandidates) {
      const probe = await runShell(ctx.destination, `test -s "${remote}"`);
      if (probe.exitCode === 0) {
        const command = `docker exec -i ${envFlag}${container} pg_restore -c --if-exists --no-owner -U ${user} -d ${name} < "${remote}"`;
        const outcome = requireResult('restore-target-db', await runShell(ctx.destination, command));
        return { ...outcome, command: undefined };
      }
    }
    // 2) Si no, el dump esta en el host de CONTROL: se envia por STDIN al contenedor del DESTINO.
    // BINARIO: se envia como Buffer (leerlo como texto corrompe el dump).
    const dump = await readFile(inFile).catch(() => undefined);
    if (dump && dump.length > 0) {
      const command = `docker exec -i ${envFlag}${container} pg_restore -c --if-exists --no-owner -U ${user} -d ${name}`;
      const outcome = requireResult('restore-target-db', await runShellWithInput(ctx.destination, command, dump));
      return { ...outcome, command: undefined };
    }
    return fail(
      'restore-target-db',
      `No hay dump para restaurar: ni en el DESTINO (${remoteCandidates.join(', ') || 'sin dstDir'}) ni local (${inFile}). ` +
        'Re-ejecuta backup-source-db (sin resume, o borra su checkpoint) para regenerarlo.',
    );
  },
};

/** `schema-upgrade`: arranca el ACS destino y espera a que aplique los schema patches. */
const schemaUpgrade: StepDefinition = {
  id: 'schema-upgrade',
  short: 'Arranca Alfresco y aplica el esquema (auto-update)',
  description:
    'Arranca Alfresco SOBRE la BD ya restaurada y espera al auto-update de esquema. La infra debe estar levantada y la BD restaurada (orden natural).',
  writes: true,
  async run(ctx) {
    const override = process.env.MIGRATOR_SCHEMA_UPGRADE_CMD;
    if (ctx.dryRun) {
      return skipped('schema-upgrade', 'dry-run');
    }
    if (override) {
      return requireResult('schema-upgrade', await runShell(ctx.destination, override));
    }
    // Sin override: arranca SOLO el servicio `alfresco` (la BD ya esta restaurada) y espera a que responda.
    const baseUrl = process.env.MIGRATOR_DST_BASE_URL ?? ctx.project.target.baseUrl;
    const compose = await hopCompose(ctx);
    if (!compose) {
      return skipped('schema-upgrade', 'sin compose del hop: define target.composeFile, MIGRATOR_DST_COMPOSE_FILE o target.dataDir');
    }
    // El content store copiado (rsync como el usuario SSH) debe ser del usuario de Alfresco en la imagen.
    const dstDir = ctx.project.target.dataDir ?? process.env.MIGRATOR_DST_DIR;
    if (!compose.external && dstDir) {
      const owner = await runShell(ctx.destination, alfDataOwnershipCommand(dstDir));
      if (owner.exitCode !== 0) {
        return fail('schema-upgrade', `no se pudo asignar ${dstDir}/alf-data al usuario de Alfresco: ${owner.stderr.trim()}`);
      }
    }
    // Compose del operador: sus `${...}` se resuelven con el `.env` junto a el (fusion con los secretos del stack).
    if (compose.external) {
      try {
        await ensureOperatorStackEnv(ctx.destination, compose.file, await ensureStackSecrets(path.join(ctx.state, 'provision')));
      } catch (error) {
        return fail('schema-upgrade', describeError(error));
      }
    }
    // --force-recreate: contenedor (y log) nuevos, para que smoke-boot no lea errores de arranques previos.
    const up = await runShell(ctx.destination, `${compose.cmd} up -d --force-recreate alfresco`);
    if (up.exitCode !== 0) {
      return fail('schema-upgrade', up.stderr.trim() || 'no se pudo arrancar el servicio alfresco');
    }
    if (!baseUrl) {
      return ok('schema-upgrade', 'alfresco arrancado (sin URL para esperar readiness)');
    }
    // Sin credenciales del destino no hay probe de readiness: fallo explicito (sin default `admin`).
    try {
      dstCreds();
    } catch (error) {
      return fail('schema-upgrade', describeError(error));
    }
    // El auto-update de esquema de un hop grande tarda: espera configurable (defecto 30 min).
    const discovery = `${baseUrl.replace(/\/$/, '')}/api/discovery`;
    const timeoutS = Number(process.env.MIGRATOR_SCHEMA_UPGRADE_TIMEOUT_S ?? 1800);
    const attempts = Math.max(1, Math.ceil(timeoutS / 10));
    for (let attempt = 1; attempt <= attempts; attempt++) {
      const probe = await runShell(ctx.destination, `curl -fsS -o /dev/null -w "%{http_code}" -u "${dstCreds()}" "${discovery}"`);
      if (probe.stdout.trim().startsWith('2')) {
        const detail = `alfresco ${compose.version} arrancado sobre la BD restaurada (discovery http=${probe.stdout.trim()})`;
        // Stack final: Share y el batch indexer arrancan cuando el repositorio ya responde (el indexer
        // necesita el endpoint de extraccion de texto y el indice/mapping que crea el repositorio).
        const share = finalShareUrl(ctx, baseUrl, compose.version);
        const lateServices = lateStackServicesFor(ctx, compose.version);
        if (compose.external || lateServices.length === 0) return ok('schema-upgrade', detail);
        const late = await runShell(ctx.destination, `${compose.cmd} up -d ${lateServices.join(' ')}`);
        if (late.exitCode !== 0) return fail('schema-upgrade', `${detail}; no arrancaron ${lateServices.join(', ')}: ${late.stderr.trim()}`);
        if (!share) return ok('schema-upgrade', `${detail} · ${lateServices.join(', ')} en marcha`);
        const code = await waitHttp(ctx.destination, share, Number(process.env.MIGRATOR_SHARE_TIMEOUT_S ?? 600));
        return code.startsWith('2') || code.startsWith('3')
          ? ok('schema-upgrade', `${detail} · share http=${code} · ${lateServices.join(', ')} en marcha`)
          : fail('schema-upgrade', `${detail}; Share no responde en ${share} (http=${code || 'sin respuesta'})`);
      }
      // Cada minuto: fallo de esquema/arranque en el log o contenedor parado => no se espera al timeout.
      if (attempt % 6 === 0) {
        const log = await runShell(ctx.destination, `${compose.cmd} logs --no-color --tail 400 alfresco`);
        const upgrade = evaluateUpgradeLog(compose.version, log.stdout);
        if (upgrade.error) {
          return fail('schema-upgrade', `fallo al arrancar ${compose.version} (${upgrade.error}): ${errorExcerpt(log.stdout) ?? ''}`);
        }
        const state = (await runShell(ctx.destination, `${compose.cmd} ps -a alfresco --format "{{.State}}"`)).stdout.trim();
        if (/exited|dead/i.test(state)) {
          return fail('schema-upgrade', `el contenedor alfresco ${compose.version} se ha parado (${state}): ${lastLines(log.stdout)}`);
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 10_000));
    }
    const tail = await runShell(ctx.destination, `${compose.cmd} logs --no-color --tail 400 alfresco`);
    return fail(
      'schema-upgrade',
      `alfresco ${compose.version} no respondio (discovery) en ${timeoutS}s: ${errorExcerpt(tail.stdout) ?? lastLines(tail.stdout)}`,
    );
  },
};

/**
 * Compose del hop en el DESTINO y el prefijo de `docker compose` para usarlo:
 * - compose del OPERADOR (`target.composeFile` / `MIGRATOR_DST_COMPOSE_FILE`): tal cual, sin `-p` (se
 *   respeta su nombre de proyecto) ni secretos del migrator;
 * - compose GENERADO (`<dataDir>/compose/docker-compose-<hop>.yml`): con el nombre de proyecto valido y
 *   los secretos del stack (sin ellos compose recrea servicios con variables vacias).
 */
/**
 * URL de Share del stack del HOP (`undefined` si ese hop no lleva Share): con proxy en el mismo origen que
 * el repositorio (/share/); sin proxy, en el 8081. El stack del hop lo resuelve `stackForVersion`.
 */
export function finalShareUrl(ctx: Pick<StepContext, 'project'>, baseUrl: string, version: string): string | undefined {
  const stack = stackForVersion(ctx.project.target, version);
  if (!stack?.share) return undefined;
  const url = new URL(baseUrl);
  if (!stack.proxy) url.port = '8081';
  return `${url.origin}/share/page`;
}

/** `true` si el hop `version` usa Search Community (batch indexer): CE 26.2+ con ES/OpenSearch. */
const hopSearchCommunity = (ctx: Pick<StepContext, 'project'>, version: string): boolean =>
  isSearchCommunity(version, ctx.project.target.edition ?? 'CE', ctx.project.target.search?.engine ?? '');

/**
 * Servicios que arrancan DESPUES de que el repositorio responda: Share y batch indexer. Salen del stack
 * DEL HOP (`stackForVersion`), el mismo que genera su compose: si ese hop no lleva stack, no se pide nada
 * (pedirlos daria `no such service`). El indexer solo en hops con Search Community. `version` = hop.
 */
export function lateStackServicesFor(ctx: Pick<StepContext, 'project'>, version: string): string[] {
  const stack = stackForVersion(ctx.project.target, version);
  if (!stack) return [];
  return [...stackLateServices(stack), ...(hopSearchCommunity(ctx, version) ? [BATCH_INDEXER_SERVICE] : [])];
}

/** Espera a que una URL responda (codigo HTTP final) hasta `timeoutS`; devuelve el ultimo codigo. */
async function waitHttp(host: HostRef, url: string, timeoutS: number): Promise<string> {
  let code = '';
  for (let attempt = 0; attempt < Math.max(1, Math.ceil(timeoutS / 10)); attempt++) {
    code = (await runShell(host, `curl -s -o /dev/null -w "%{http_code}" "${url}"`)).stdout.trim();
    if (code.startsWith('2') || code.startsWith('3')) return code;
    await new Promise((resolve) => setTimeout(resolve, 10_000));
  }
  return code;
}

/** uid del usuario `alfresco` en las imagenes del repositorio (7.x a 26.x). */
export const ALFRESCO_UID = 33000;

/** Da `<dataDir>/alf-data` al usuario de Alfresco sin sudo (contenedor efimero como root). */
export const alfDataOwnershipCommand = (dstDir: string): string =>
  `docker run --rm -v "${dstDir}/alf-data:/d" alpine chown -R ${ALFRESCO_UID} /d`;

async function hopCompose(ctx: StepContext): Promise<{ cmd: string; file: string; version: string; external: boolean } | undefined> {
  const version = ctx.hop ?? ctx.project.target.version;
  const dstDir = ctx.project.target.dataDir ?? process.env.MIGRATOR_DST_DIR;
  const explicit = process.env.MIGRATOR_DST_COMPOSE_FILE;
  const external = !explicit && !!ctx.project.target.composeFile;
  const file = explicit ?? ctx.project.target.composeFile ?? (dstDir ? hopComposeFile(dstDir, version) : undefined);
  if (!file) return undefined;
  const projectEnv = process.env.MIGRATOR_DST_COMPOSE_PROJECT;
  if (external) {
    return { cmd: `docker compose -f "${file}"${projectEnv ? ` -p "${projectEnv}"` : ''}`, file, version, external };
  }
  const secrets = await ensureStackSecrets(path.join(ctx.state, 'provision'));
  const project = projectEnv ?? composeProjectName(ctx.project.project);
  return { cmd: `${composeEnvPrefix(secrets)} docker compose -f "${file}" -p "${project}"`, file, version, external };
}

/**
 * `provision-hop`: pone el DESTINO en la version del hop que toca. Para los stacks de Alfresco del
 * DESTINO y levanta la INFRA con el compose de la version del hop, CONSERVANDO los datos (BD en el
 * volumen del proyecto y content store en `<dataDir>/alf-data`). Alfresco arranca en `schema-upgrade`.
 */
const provisionHop: StepDefinition = {
  id: 'provision-hop',
  short: 'Despliega en el DESTINO la version del hop (conserva los datos)',
  description:
    'Pone el DESTINO en la version del hop que toca (7.4 -> 25.3 -> 26.2): para el stack anterior y levanta la infraestructura con <dataDir>/compose/docker-compose-<hop>.yml conservando BD y content store. Alfresco se arranca en schema-upgrade. Debe ir PRIMERO en la composicion del hop.',
  writes: true,
  async run(ctx) {
    const hop = ctx.hop;
    if (!hop) {
      return fail('provision-hop', 'sin hop resuelto: lo calcula migrator_run_steps desde .migrator/hops.jsonl');
    }
    const composeFile = process.env.MIGRATOR_DST_COMPOSE_FILE ?? ctx.project.target.composeFile;
    if (composeFile) {
      return fail(
        'provision-hop',
        `El DESTINO usa el compose del operador (${composeFile}): el migrator no cambia su version. ` +
          `Pon la imagen del repositorio en ${hop} en ese compose y ejecuta el hop SIN provision-hop (la guarda de hops verifica la version).`,
      );
    }
    const dstDir = ctx.project.target.dataDir ?? process.env.MIGRATOR_DST_DIR;
    if (!dstDir) {
      return fail('provision-hop', 'Falta el directorio de version del DESTINO: define target.dataDir o MIGRATOR_DST_DIR');
    }
    // La BD debe ser la MISMA en todos los hops: si ya existe <dataDir>/pg-data se monta como bind.
    const pgBind =
      ['true', '1', 'yes', 'on'].includes((process.env.MIGRATOR_DST_PG_BIND ?? '').toLowerCase()) ||
      (await hasPgDataBind(ctx.destination, dstDir));
    // JAR de modelos del INSTALADOR (target.modelsJar): se valida ANTES de tocar el destino.
    const localJar = ctx.project.target.modelsJar;
    const hasModels = !!localJar;
    const remoteJar = localJar ? `${dstDir}/models/${path.basename(localJar)}` : '';
    const check = localJar ? await validateModelsJar(localJar) : undefined;
    if (localJar && check && !check.ok) return fail('provision-hop', `JAR de modelos del instalador invalido (${localJar}): ${check.reason}`);
    // PRIMER hop: los namespaces PROPIOS que usan los nodos del origen deben estar cubiertos por el JAR (o
    // declarados como no necesarios). Si no, los nodos quedarian sin definicion: BLOQUEO (fail-closed).
    const firstHop = requireSupportedUpgradePath(ctx.project.source.version, ctx.project.target.version)[0]?.to;
    if (firstHop && sameMinor(hop, firstHop)) {
      const coverage = await sourceModelsCoverage(ctx, check?.models ?? []);
      if (typeof coverage === 'string') return fail('provision-hop', coverage);
      if (coverage.missing.length) {
        return fail(
          'provision-hop',
          `BLOQUEO (decision humana): el origen usa modelos propios no cubiertos ${localJar ? `por ${path.basename(localJar)}` : '(sin target.modelsJar)'}: ${coverage.missing.join(', ')}. ` +
            'El instalador debe aportar el JAR de modelos (target.modelsJar) que los defina, o declararlos en target.modelsNotRequired si no se migran.',
        );
      }
      if (!ctx.dryRun) {
        const needsCode = (check?.models ?? []).flatMap((m) => m.classConstraints.map((c) => `${m.name}: ${c}`));
        const summary = coverage.custom.length === 0
          ? 'el origen no usa modelos propios'
          : `${localJar ? `${path.basename(localJar)} (${check!.models.map((m) => m.name).join(', ')})` : 'sin JAR'} cubre ${coverage.custom.length - coverage.accepted.length}/${coverage.custom.length} namespaces propios en uso` +
            (coverage.accepted.length ? `; no migrados por decision humana: ${coverage.accepted.join(', ')}` : '');
        const jarWarnings = check?.warnings ?? [];
        await recordEvidence(ctx.state, ctx.project.project, 'models', needsCode.length || coverage.accepted.length || jarWarnings.length ? 'WARN' : 'OK',
          summary + (needsCode.length ? ` · restricciones con clase Java (necesitan el codigo): ${needsCode.join('; ')}` : '') +
            (jarWarnings.length ? ` · avisos del JAR: ${jarWarnings.join('; ')}` : ''));
      }
    }
    const plan = { ...projectToComposeRequest(ctx.project, hop, false, undefined, dstDir, pgBind), ...(hasModels ? { modelsJar: remoteJar } : {}) };
    const file = hopComposeFile(dstDir, hop);
    const images = composeImages(plan);
    const repoImage = images[images.length - 1]!;
    if (isPrereleaseImage(repoImage)) {
      return fail('provision-hop', `Imagen PRE-RELEASE no permitida: ${repoImage}`);
    }
    if (ctx.dryRun) {
      const models = check
        ? ` · modelos ${path.basename(localJar!)}${check.moduleId ? ` (modulo ${check.moduleId})` : ''}: ${check.models.map((m) => m.name).join(', ')}` +
          (check.warnings.length ? ` · AVISOS del JAR: ${check.warnings.join('; ')}` : '')
        : ' · sin JAR de modelos';
      return skipped('provision-hop', `dry-run: hop ${hop} · ${file} · ${repoImage}${models}`);
    }
    const host = ctx.destination;
    try {
      const memTotal = await dockerMemTotal(host);
      const request = { ...plan, memory: memTotal ? computeAlfrescoMemory(memTotal) : undefined };
      // Search Community (hop FINAL): si el humano aporta el mapa COMPLETO de namespaces, se monta en el
      // batch indexer (sin el, un namespace propio ausente deja nodos SIN indexar en silencio).
      const localPrefixes = process.env.MIGRATOR_REINDEX_PREFIXES_FILE;
      const remotePrefixes = `${dstDir}/reindex/prefixes.json`;
      if (hopSearchCommunity(ctx, hop) && stackForVersion(ctx.project.target, hop) && localPrefixes) {
        request.reindexPrefixesFile = remotePrefixes;
      }
      const registry = imageRegistry(repoImage);
      const user = process.env.MIGRATOR_REGISTRY_USER ?? process.env.MIGRATOR_EE_USER;
      const password = process.env.MIGRATOR_REGISTRY_PASSWORD ?? process.env.MIGRATOR_EE_PASSWORD;
      if (registry && user && password) await registryLogin(host, registry, user, password);
      // Validar ANTES de parar nada: un compose invalido o una imagen inexistente no deben dejar el destino caido.
      const invalid = await validateCompose(host, renderCompose(request));
      if (invalid) return fail('provision-hop', `compose del hop ${hop} invalido: ${invalid}`);
      const missing = await missingImages(host, images);
      if (missing.length > 0) return fail('provision-hop', `imagenes inexistentes en el registro: ${missing.join(', ')}`);
      const workDir = path.join(ctx.state, 'provision');
      const secrets = await ensureStackSecrets(workDir);
      await ensureDataDirs(host, dstDir, pgBind);
      // JAR de modelos del instalador: copia binaria verificada al DESTINO, montado en cada hop.
      if (localJar) {
        const copied = await copyDumpToDestination(host, localJar, remoteJar);
        if (!copied.ok) return fail('provision-hop', `no se pudo copiar el JAR de modelos al DESTINO: ${copied.reason}`);
      }
      if (request.reindexPrefixesFile && localPrefixes) {
        const copied = await copyDumpToDestination(host, localPrefixes, remotePrefixes);
        if (!copied.ok) return fail('provision-hop', `no se pudo copiar el prefix-map al DESTINO: ${copied.reason}`);
      }
      await writeStackConfig(host, dstDir, globalProperties(request, secrets));
      const stopped = await stopRunningStacks(host, composeProjectName(ctx.project.project));
      await provisionCompose(request, workDir, host);
      return ok(
        'provision-hop',
        `hop ${hop}: infraestructura levantada con ${file} (${repoImage})${hasModels ? ` · modelos ${path.basename(remoteJar)}` : ''}, contraseña de BD alineada${stopped.length ? ` · parados: ${stopped.join(', ')}` : ''}`,
      );
    } catch (error) {
      return fail('provision-hop', describeError(error));
    }
  },
};

/**
 * `smoke-boot`: verifica el hop recien arrancado (fail-closed): version del DESTINO == hop, raiz
 * resuelve y log sin errores de esquema. Solo lectura. Autoriza a registrar el hop como hecho.
 */
const smokeBoot: StepDefinition = {
  id: 'smoke-boot',
  short: 'Comprueba que el DESTINO arranco bien (solo lectura)',
  description:
    'Smoke test del hop (solo lectura): el DESTINO responde EN LA VERSION DEL HOP, la raiz resuelve y el log de alfresco no tiene errores de esquema. Va tras schema-upgrade.',
  writes: false,
  async run(ctx) {
    const hop = ctx.hop ?? ctx.project.target.version;
    if (ctx.dryRun) return skipped('smoke-boot', `dry-run: smoke del hop ${hop}`);
    const baseUrl = process.env.MIGRATOR_DST_BASE_URL ?? ctx.project.target.baseUrl;
    if (!baseUrl) return fail('smoke-boot', 'sin MIGRATOR_DST_BASE_URL / target.baseUrl: no se puede verificar el hop');
    let creds: string;
    try {
      creds = dstCreds();
    } catch (error) {
      return fail('smoke-boot', describeError(error));
    }
    const [user, password] = creds.split(':');
    const detected = await discoverRest(baseUrl, user, password);
    const root = await runShell(
      ctx.destination,
      `curl -s -o /dev/null -w "%{http_code}" -u "${creds}" "${baseUrl.replace(/\/$/, '')}/api/-default-/public/alfresco/versions/1/nodes/-root-"`,
    );
    const compose = await hopCompose(ctx);
    const log = compose ? (await runShell(ctx.destination, `${compose.cmd} logs --no-color --tail 500 alfresco`)).stdout : '';
    const smoke = evaluateSmoke({ hop, version: detected?.version, rootCode: root.stdout.trim(), log });
    let detail = `hop ${hop} · version=${detected?.version ?? 'no detectada'} · root http=${root.stdout.trim() || 'sin respuesta'}`;
    if (!smoke.ok) return fail('smoke-boot', `${detail} — ${smoke.reason}`);
    // Stack final con Share: tambien debe responder.
    const share = finalShareUrl(ctx, baseUrl, hop);
    if (share) {
      const code = (await runShell(ctx.destination, `curl -s -o /dev/null -w "%{http_code}" "${share}"`)).stdout.trim();
      detail += ` · share http=${code || 'sin respuesta'}`;
      if (!(code.startsWith('2') || code.startsWith('3'))) return fail('smoke-boot', `${detail} — Share no responde en ${share}`);
    }
    return ok('smoke-boot', detail);
  },
};

/**
 * Comprueba el `prefixes-file` del batch indexer contra los namespaces propios de los modelos (JAR del
 * instalador). El fichero REEMPLAZA el mapa embebido: un namespace ausente deja nodos sin indexar EN
 * SILENCIO, por eso un fichero aportado que no los cubra BLOQUEA el reindex.
 */
async function prefixMapNote(ctx: StepContext): Promise<{ ok: boolean; detail: string }> {
  const jar = ctx.project.target.modelsJar;
  if (!jar) return { ok: true, detail: 'prefix-map: sin target.modelsJar (no se validan namespaces propios)' };
  const check = await validateModelsJar(jar).catch(() => undefined);
  if (!check?.ok) return { ok: true, detail: 'prefix-map: JAR de modelos no validable' };
  const required = prefixesFromModels(check.models);
  const file = process.env.MIGRATOR_REINDEX_PREFIXES_FILE;
  if (!file) {
    return {
      ok: true,
      detail: `prefix-map: ${required.length} namespaces propios; el fichero del indexador debe ser el mapa COMPLETO (incluye los de Alfresco): genera con model-ns-prefix-mapping y define MIGRATOR_REINDEX_PREFIXES_FILE para validarlo`,
    };
  }
  try {
    // El indexador consume `{"prefixUriMap": {uri: prefix}}`; el addon y otros generadores pueden dar el mapa
    // PLANO. Se aceptan ambas formas.
    const provided = prefixMapFromJson(JSON.parse(await readFile(file, 'utf8')));
    const missing = missingPrefixes(required, provided);
    if (missing.length) {
      return {
        ok: false,
        detail: `prefix-map INCOMPLETO (${file}): faltan ${missing.map((m) => `${m.prefix}=${m.uri}`).join(', ')}; esos nodos NO se indexarian. Regenera el mapa con el addon model-ns-prefix-mapping del repositorio y reintenta.`,
      };
    }
    return { ok: true, detail: `prefix-map: ${required.length} namespaces propios cubiertos por ${file}` };
  } catch (error) {
    return { ok: false, detail: `prefix-map: no se pudo leer ${file}: ${describeError(error)}` };
  }
}

/** `reindex`: regenera el indice de busqueda en el destino (batch-indexing por watermark / Reindexing app / Solr). */
const reindex: StepDefinition = {
  id: 'reindex',
  short: 'Regenera el indice de busqueda (solo en la version final)',
  description: 'Regenera el indice de busqueda del DESTINO. SOLO en la version FINAL (nunca por hop).',
  writes: true,
  async run(ctx, params) {
    const override = process.env.MIGRATOR_REINDEX_CMD;
    const engine = (ctx.project.target.search?.engine ?? 'solr').toUpperCase();
    const edition = (ctx.project.target.edition ?? 'CE').toUpperCase();
    const strategy = resolveReindexStrategy(engine, ctx.project.target.search?.version ?? '', ctx.project.target.version, edition);
    if (ctx.dryRun) {
      return skipped('reindex', `dry-run: ${strategy.kind}`);
    }
    // NUNCA reindexar en hops intermedios: solo cuando el DESTINO ya esta en la version FINAL del proyecto.
    const baseUrl = process.env.MIGRATOR_DST_BASE_URL ?? ctx.project.target.baseUrl;
    const detected = baseUrl
      ? await discoverRest(
          baseUrl,
          process.env.MIGRATOR_DST_USER ?? process.env.MIGRATOR_SRC_USER,
          process.env.MIGRATOR_DST_PASSWORD ?? process.env.MIGRATOR_SRC_PASSWORD,
        )
      : undefined;
    if (detected && !sameMinor(detected.version, ctx.project.target.version)) {
      return skipped(
        'reindex',
        `reindex SOLO en la version final (${ctx.project.target.version}); el DESTINO esta en ${detected.version}: se omite en hops intermedios`,
      );
    }
    if (override) {
      const values = {
        prefixesFile: String(params.prefixesFile ?? ''),
        dbUrl: String(params.dbUrl ?? destinationDbUrl(ctx.project)),
      };
      return requireResult('reindex', await runShell(ctx.destination, substitute(override, values)));
    }
    // Search Community (CE 26.2+): el indice se regenera por SONDEO. NO indexa el historico por si solo:
    // hay que sembrar el cursor (watermark) en el primer commit de la BD y mantener maxGapAge=0 hasta el presente.
    if (strategy.kind === 'SEARCH_COMMUNITY') {
      const prefixes = await prefixMapNote(ctx);
      if (!prefixes.ok) return fail('reindex', prefixes.detail);
      const db = ctx.project.target.database;
      const script = searchCommunityReindexScript({
        project: composeProjectName(ctx.project.project),
        dbContainer: process.env.MIGRATOR_DST_PG_CONTAINER ?? db?.container,
        dbUser: db?.user ?? 'alfresco',
        dbName: db?.name ?? 'alfresco',
        dbPassword: process.env.MIGRATOR_DST_DB_PASSWORD ?? process.env.MIGRATOR_SRC_DB_PASSWORD,
        searchContainer: process.env.MIGRATOR_DST_SEARCH_CONTAINER,
        searchUrl: process.env.MIGRATOR_DST_SEARCH_URL,
        stateIndex: process.env.MIGRATOR_REINDEX_STATE_INDEX,
      });
      const outcome = requireResult('reindex', await runShell(ctx.destination, script));
      // El comando puede llevar la password de la BD: no se expone.
      return outcome.ok
        ? { ...outcome, command: undefined, detail: `${outcome.detail} · ${prefixes.detail} · maxGapAge=0 requerido hasta alcanzar el presente` }
        : { ...outcome, command: undefined };
    }
    // Solr / Search Enterprise: cada instalacion usa su comando; en la version FINAL el indice es
    // obligatorio, asi que se falla con el bloqueo concreto en vez de dar un OK falso.
    return fail(
      'reindex',
      `BLOQUEO (decision humana): no hay mecanismo automatico de reindexado para ${edition} ${ctx.project.target.version} con ${engine}. ` +
        (engine === 'SOLR'
          ? 'Define MIGRATOR_REINDEX_CMD con el reindexado de Solr (tracking/borrado de cores).'
          : 'Define MIGRATOR_REINDEX_CMD con la Alfresco Reindexing app (Search Enterprise).'),
    );
  },
};

/** `verify-target`: comprueba la salud del destino tras la migracion. */
const verifyTarget: StepDefinition = {
  id: 'verify-target',
  short: 'Verifica la salud del DESTINO (REST y recuento de nodos)',
  description: 'Comprueba salud del destino (readiness REST y conteo de nodos por JDBC).',
  writes: false,
  async run(ctx) {
    const baseUrl = process.env.MIGRATOR_DST_BASE_URL ?? ctx.project.target.baseUrl;
    if (!baseUrl) {
      return skipped('verify-target', 'sin MIGRATOR_DST_BASE_URL');
    }
    const base = baseUrl.replace(/\/$/, '');
    let creds: string;
    try {
      creds = dstCreds();
    } catch (error) {
      return fail('verify-target', describeError(error));
    }
    // Readiness: el repositorio responde (discovery).
    const ready = await runShell(ctx.destination, `curl -fsS -o /dev/null -w "%{http_code}" -u "${creds}" "${base}/api/discovery"`);
    const readyCode = ready.stdout.trim();
    // COHERENCIA app<->BD: `-root-` debe resolver (si Alfresco arranco sobre una BD vacia y luego se
    // restauro, la raiz da 404 aunque el endpoint este "ready").
    const root = await runShell(ctx.destination, `curl -s -o /dev/null -w "%{http_code}" -u "${creds}" "${base}/api/-default-/public/alfresco/versions/1/nodes/-root-"`);
    const rootCode = root.stdout.trim();
    const detail = `discovery http=${readyCode || 'sin respuesta'} · root http=${rootCode || 'sin respuesta'}`;
    if (!readyCode.startsWith('2')) return fail('verify-target', detail);
    if (!rootCode.startsWith('2')) {
      return fail('verify-target', `${detail} — la raiz NO resuelve: app y BD desalineadas (¿Alfresco arranco antes del restore?)`);
    }
    return ok('verify-target', detail);
  },
};

export const STEPS: StepDefinition[] = [
  preflightTarget,
  provisionHop,
  backupSourceDb,
  copyContent,
  restoreTargetDb,
  schemaUpgrade,
  smokeBoot,
  reindex,
  verifyTarget,
];

export function stepById(id: string): StepDefinition | undefined {
  return STEPS.find((s) => s.id === id);
}
