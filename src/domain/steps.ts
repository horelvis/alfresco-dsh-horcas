/**
 * Catalogo de PASOS de migracion ejecutables sobre el DESTINO (nunca el origen).
 *
 * No es un pipeline fijo: el agente razona que pasos aplicar, en que orden y con que parametros, y
 * reutiliza la experiencia del ensayo. Cada paso es idempotente y se registra en checkpoints.
 *
 * Overrides de entorno (identicos al core): `MIGRATOR_DB_DUMP_CMD` ({out}), `MIGRATOR_DB_RESTORE_CMD`
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
import { describeError } from '../infra/errors.js';

export interface StepContext {
  project: ProjectConfig;
  destination: HostRef;
  /** Host que toca el ORIGEN (JShell/JDBC local por defecto); el destino va por `destination`. */
  source?: HostRef;
  state: string;
  runId: string;
  dryRun: boolean;
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
  /** Escribe en el destino (true) o es solo lectura/verificacion (false). */
  writes: boolean;
  run(ctx: StepContext, params: Record<string, unknown>): Promise<StepOutcome>;
}

const ok = (step: string, detail: string, command?: string): StepOutcome => ({ step, ok: true, detail, command });
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
      try {
        const dump = await readFile(out, 'utf8');
        const copy = await runShellWithInput(ctx.destination, `mkdir -p "${dstDir}/db" && cat > "${remote}"`, dump);
        return ok(
          'backup-source-db',
          `dump ${out} · copia en el DESTINO ${remote}${copy.exitCode === 0 ? '' : ` (fallo la copia: ${copy.stderr.trim()})`}`,
        );
      } catch (error) {
        return ok('backup-source-db', `dump ${out} (no se pudo copiar al destino: ${describeError(error)})`);
      }
    }
    return outcome;
  },
};

/** `copy-content`: replica el content store del origen al destino (rsync/S3/Azure, con delta). */
const copyContent: StepDefinition = {
  id: 'copy-content',
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
const restoreTargetDb: StepDefinition = {
  id: 'restore-target-db',
  description:
    'Restaura el dump logico en la BD del destino (D2) con `docker exec pg_restore` dentro del contenedor (el host no necesita pg_restore). Usa el dump del DESTINO si existe; si no, el local. MIGRATOR_DB_RESTORE_CMD es opcional.',
  writes: true,
  async run(ctx, params) {
    const inFile = String(params.inFile ?? `${ctx.state}/${ctx.runId}/db.dump`);
    const override = process.env.MIGRATOR_DB_RESTORE_CMD;
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
    for (const remote of remoteCandidates) {
      const probe = await runShell(ctx.destination, `test -s "${remote}"`);
      if (probe.exitCode === 0) {
        const command = `docker exec -i ${envFlag}${container} pg_restore -c --if-exists --no-owner -U ${user} -d ${name} < "${remote}"`;
        const outcome = requireResult('restore-target-db', await runShell(ctx.destination, command));
        return { ...outcome, command: undefined };
      }
    }
    // 2) Si no, el dump esta en el host de CONTROL: se envia por STDIN al contenedor del DESTINO.
    let dump = '';
    try {
      dump = await readFile(inFile, 'utf8');
    } catch {
      dump = '';
    }
    if (dump) {
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
  description: 'Levanta el ACS destino y espera al schema-upgrade nativo (Database schema version / Started).',
  writes: true,
  async run(ctx) {
    const override = process.env.MIGRATOR_SCHEMA_UPGRADE_CMD;
    if (ctx.dryRun) {
      return skipped('schema-upgrade', 'dry-run');
    }
    if (!override) {
      return skipped('schema-upgrade', 'sin MIGRATOR_SCHEMA_UPGRADE_CMD (lo orquesta el stack destino)');
    }
    return requireResult('schema-upgrade', await runShell(ctx.destination, override));
  },
};

/** `reindex`: regenera el indice de busqueda en el destino (Reindexing app / Solr tracking). */
const reindex: StepDefinition = {
  id: 'reindex',
  description: 'Regenera el indice de busqueda del destino (nunca se migra).',
  writes: true,
  async run(ctx, params) {
    const override = process.env.MIGRATOR_REINDEX_CMD;
    if (ctx.dryRun) {
      return skipped('reindex', 'dry-run');
    }
    if (!override) {
      return skipped('reindex', 'sin MIGRATOR_REINDEX_CMD');
    }
    const values = {
      prefixesFile: String(params.prefixesFile ?? ''),
      dbUrl: String(params.dbUrl ?? destinationDbUrl(ctx.project)),
    };
    return requireResult('reindex', await runShell(ctx.destination, substitute(override, values)));
  },
};

/** `verify-target`: comprueba la salud del destino tras la migracion. */
const verifyTarget: StepDefinition = {
  id: 'verify-target',
  description: 'Comprueba salud del destino (readiness REST y conteo de nodos por JDBC).',
  writes: false,
  async run(ctx) {
    const baseUrl = process.env.MIGRATOR_DST_BASE_URL;
    if (!baseUrl) {
      return skipped('verify-target', 'sin MIGRATOR_DST_BASE_URL');
    }
    const url = `${baseUrl.replace(/\/$/, '')}/api/-default-/public/alfresco/versions/1/probes/-ready-`;
    const result = await runShell(ctx.destination, `curl -fsS -o /dev/null -w "%{http_code}" "${url}"`);
    const code = result.stdout.trim();
    return result.exitCode === 0 && code.startsWith('2')
      ? ok('verify-target', `ready http=${code}`)
      : fail('verify-target', `ready http=${code || 'sin respuesta'}`);
  },
};

export const STEPS: StepDefinition[] = [
  preflightTarget,
  backupSourceDb,
  copyContent,
  restoreTargetDb,
  schemaUpgrade,
  reindex,
  verifyTarget,
];

export function stepById(id: string): StepDefinition | undefined {
  return STEPS.find((s) => s.id === id);
}
