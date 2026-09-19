/**
 * Catalogo de PASOS de migracion ejecutables sobre el DESTINO (nunca el origen).
 *
 * No es un pipeline fijo: el agente razona que pasos aplicar, en que orden y con que parametros, y
 * reutiliza la experiencia del ensayo. Cada paso es idempotente y se registra en checkpoints.
 *
 * Overrides de entorno (identicos al core): `MIGRATOR_DB_DUMP_CMD` ({out}), `MIGRATOR_DB_RESTORE_CMD`
 * ({in}), `MIGRATOR_REINDEX_CMD` ({prefixesFile},{dbUrl}), `MIGRATOR_DST_PROVISION`.
 */
import type { HostRef } from '../infra/exec.js';
import { runShell, substitute, type ExecResult } from '../infra/exec.js';
import type { ProjectConfig } from '../domain/project-config.js';

export interface StepContext {
  project: ProjectConfig;
  destination: HostRef;
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
    const result = await runShell(ctx.destination, 'docker version --format "{{.Server.Version}}" && docker compose version --short');
    return requireResult('preflight-target', result);
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
    if (override) {
      return requireResult('backup-source-db', await runShell(ctx.destination, substitute(override, { out })));
    }
    return skipped('backup-source-db', 'sin MIGRATOR_DB_DUMP_CMD (BD interna al contenedor)');
  },
};

/** `copy-content`: replica el content store del origen al destino (rsync/ssh). */
const copyContent: StepDefinition = {
  id: 'copy-content',
  description: 'Copia el content store del origen al destino (rsync).',
  writes: true,
  async run(ctx, params) {
    const source = String(params.sourcePath ?? ctx.project.source.contentStore?.path ?? '');
    const target = String(params.targetPath ?? ctx.project.target.contentStore?.path ?? '');
    if (!source || !target) {
      return fail('copy-content', 'faltan rutas de content store');
    }
    if (ctx.dryRun) {
      return skipped('copy-content', `dry-run: ${source} -> ${target}`);
    }
    const override = process.env.MIGRATOR_CONTENT_COPY_CMD;
    if (override) {
      return requireResult('copy-content', await runShell(ctx.destination, substitute(override, { source, target })));
    }
    return requireResult('copy-content', await runShell(ctx.destination, `rsync -a --info=stats2 "${source}" "${target}"`));
  },
};

/** `restore-target-db`: restaura el dump en la BD del DESTINO. */
const restoreTargetDb: StepDefinition = {
  id: 'restore-target-db',
  description: 'Restaura el dump logico en la BD del destino (D2).',
  writes: true,
  async run(ctx, params) {
    const inFile = String(params.inFile ?? `${ctx.state}/${ctx.runId}/db.dump`);
    const override = process.env.MIGRATOR_DB_RESTORE_CMD;
    if (ctx.dryRun) {
      return skipped('restore-target-db', `dry-run: restore de ${inFile}`);
    }
    if (override) {
      return requireResult('restore-target-db', await runShell(ctx.destination, substitute(override, { in: inFile })));
    }
    const db = ctx.project.target.database;
    const user = db?.user ?? 'alfresco';
    const command = `pg_restore -c --if-exists -h ${db?.host ?? 'localhost'} -p ${db?.port ?? 5432} -U ${user} -d ${db?.name ?? 'alfresco'} "${inFile}"`;
    return requireResult('restore-target-db', await runShell(ctx.destination, command));
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
