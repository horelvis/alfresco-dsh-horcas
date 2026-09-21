/**
 * Acceso READ-ONLY a PostgreSQL. Toda sentencia pasa por `selectOnly()`. Nunca DML/DDL.
 * El origen es inmutable por diseño: las tools de migracion solo SELECT sobre el.
 */
import pg from 'pg';
import { describeError } from './errors.js';

const { Client } = pg;

export interface SourceDbConfig {
  host: string;
  port: number;
  name: string;
  user: string;
  password?: string;
}

export function selectOnly(sql: string): string {
  const normalized = sql.trim().toLowerCase();
  if (!(normalized.startsWith('select') || normalized.startsWith('with'))) {
    throw new Error('Solo se permiten SELECT/WITH (read-only): ' + sql);
  }
  return sql;
}

/** Extrae host/puerto/base de una URL JDBC o postgresql (el .env usa `jdbc:postgresql://...`). */
export function parsePostgresUrl(url?: string): { host?: string; port?: number; database?: string } {
  if (!url) return {};
  const clean = url.replace(/^jdbc:/, '');
  try {
    const parsed = new URL(clean);
    return {
      host: parsed.hostname || undefined,
      port: parsed.port ? Number.parseInt(parsed.port, 10) : undefined,
      database: parsed.pathname.replace(/^\//, '') || undefined,
    };
  } catch {
    return {};
  }
}

export function sourceDbConfigFromEnv(env: NodeJS.ProcessEnv = process.env): SourceDbConfig {
  const fromUrl = parsePostgresUrl(env.MIGRATOR_SRC_DB_URL);
  return {
    host: env.MIGRATOR_SRC_DB_HOST ?? fromUrl.host ?? 'localhost',
    port: Number.parseInt(env.MIGRATOR_SRC_DB_PORT ?? String(fromUrl.port ?? 5432), 10),
    name: env.MIGRATOR_SRC_DB_NAME ?? fromUrl.database ?? 'alfresco',
    user: env.MIGRATOR_SRC_DB_USER ?? 'alfresco',
    password: env.MIGRATOR_SRC_DB_PASSWORD,
  };
}

/** Config de la BD del DESTINO (paridad). Mismas variables que el resto del plugin: MIGRATOR_DST_DB_*. */
export function targetDbConfigFromEnv(env: NodeJS.ProcessEnv = process.env): SourceDbConfig {
  const fromUrl = parsePostgresUrl(env.MIGRATOR_DST_DB_URL);
  return {
    host: env.MIGRATOR_DST_DB_HOST ?? fromUrl.host ?? 'localhost',
    port: Number.parseInt(env.MIGRATOR_DST_DB_PORT ?? String(fromUrl.port ?? 5432), 10),
    name: env.MIGRATOR_DST_DB_NAME ?? fromUrl.database ?? 'alfresco',
    user: env.MIGRATOR_DST_DB_USER ?? 'alfresco',
    password: env.MIGRATOR_DST_DB_PASSWORD,
  };
}

/**
 * Config de BD a partir de los HECHOS del proyecto (YAML: host/puerto/base/usuario) y del `.env` SOLO
 * para secretos/overrides (`MIGRATOR_{SRC|DST}_DB_*`). El host del destino vive en el YAML, no en `.env`.
 */
export function dbConfigFromYaml(
  db: { host?: string; port?: number; name?: string; user?: string } | undefined,
  kind: 'SRC' | 'DST',
  env: NodeJS.ProcessEnv = process.env,
): SourceDbConfig {
  const fromUrl = parsePostgresUrl(env[`MIGRATOR_${kind}_DB_URL`]);
  return {
    host: env[`MIGRATOR_${kind}_DB_HOST`] ?? fromUrl.host ?? db?.host ?? 'localhost',
    port: Number.parseInt(env[`MIGRATOR_${kind}_DB_PORT`] ?? String(fromUrl.port ?? db?.port ?? 5432), 10),
    name: env[`MIGRATOR_${kind}_DB_NAME`] ?? fromUrl.database ?? db?.name ?? 'alfresco',
    user: env[`MIGRATOR_${kind}_DB_USER`] ?? db?.user ?? 'alfresco',
    password: env[`MIGRATOR_${kind}_DB_PASSWORD`],
  };
}

export async function connectSource(config: SourceDbConfig): Promise<pg.Client> {
  const client = new Client({
    host: config.host,
    port: config.port,
    database: config.name,
    user: config.user,
    password: config.password,
  });
  try {
    await client.connect();
    return client;
  } catch (error) {
    await client.end().catch(() => undefined);
    throw new Error(`No se pudo conectar a PostgreSQL ${config.host}:${config.port}/${config.name}: ${describeError(error)}`);
  }
}

export async function queryRows(
  client: pg.Client,
  sql: string,
  params: unknown[] = [],
): Promise<Record<string, unknown>[]> {
  // node-postgres usa placeholders $1..$n; aceptamos tambien `?` por comodidad.
  let index = 0;
  const normalized = selectOnly(sql).replace(/\?/g, () => `$${++index}`);
  const result = await client.query(normalized, params);
  return result.rows as Record<string, unknown>[];
}

/** PK + indices UNIQUE de las tablas `alf_*` (desde pg_index; Alfresco declara unicos como indices). */
export const CONSTRAINTS_SQL = `
SELECT t.relname AS table_name,
       CASE WHEN x.indisprimary THEN 'p' ELSE 'u' END AS contype,
       i.relname AS index_name,
       (SELECT string_agg(a.attname, ',' ORDER BY u.ord)
          FROM unnest(x.indkey) WITH ORDINALITY u(attnum, ord)
          JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = u.attnum) AS cols
FROM pg_index x
JOIN pg_class t ON t.oid = x.indrelid
JOIN pg_class i ON i.oid = x.indexrelid
WHERE x.indisunique AND t.relkind = 'r' AND t.relname LIKE 'alf_%'`;

/** Suscripciones + slots de replicacion logica (0 = sin CDC). */
export const REPLICATION_SQL = `
SELECT (SELECT COUNT(*) FROM pg_subscription) + (SELECT COUNT(*) FROM pg_replication_slots) AS objects`;
