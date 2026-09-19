/**
 * Registro durable de EXPERIENCIA de migracion.
 *
 * Una migracion se prueba primero en un clon de produccion / TEST. Ese ensayo se guarda con el
 * *fingerprint* del origen (version, esquema, inventario) para poder REUTILIZARLO en PROD: antes de
 * ejecutar en produccion se comprueba que el origen de PROD no ha derivado del clon ensayado.
 *
 * La memoria de sesion del arnes (`dsh`) es conversacional; este es el artefacto de dominio, estructurado
 * y consultable por las tools en cualquier sesion futura.
 */
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';

export type Stage = 'clone' | 'test' | 'prod';

export interface SourceFingerprint {
  version: string;
  referenceVersion: string;
  schemaHealthy: boolean;
  schemaMismatches: number;
  replicationObjects: number;
  nodes: number;
  dbSizeBytes: number;
}

export interface ExperienceStep {
  id: string;
  ok: boolean;
  durationMs: number;
}

export interface ExperienceFinding {
  code: string;
  severity: string;
  detail?: string;
}

export interface ExperienceRecord {
  id: string;
  createdAt: string;
  project: string;
  stage: Stage;
  sourceVersion: string;
  targetVersion: string;
  /** Ensayo considerado bueno: esquema sano y sin CDC. */
  validated: boolean;
  fingerprint: SourceFingerprint;
  steps: ExperienceStep[];
  findings: ExperienceFinding[];
  notes?: string;
}

export type DriftKind = 'VERSION' | 'REFERENCE_VERSION' | 'SCHEMA_DEFECT' | 'REPLICATION' | 'NODE_COUNT' | 'DB_SIZE';
export type DriftSeverity = 'BLOCKER' | 'WARN' | 'INFO';

export interface DriftFinding {
  kind: DriftKind;
  severity: DriftSeverity;
  detail: string;
}

export function stateDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.MIGRATOR_STATE ?? '.migrator';
}

export function experienceFile(state: string): string {
  return path.join(state, 'experience.jsonl');
}

export async function recordExperience(state: string, record: ExperienceRecord): Promise<void> {
  await mkdir(state, { recursive: true });
  await appendFile(experienceFile(state), JSON.stringify(record) + '\n', 'utf8');
}

export async function loadExperiences(state: string, project?: string): Promise<ExperienceRecord[]> {
  let text: string;
  try {
    text = await readFile(experienceFile(state), 'utf8');
  } catch {
    return [];
  }
  return text
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as ExperienceRecord)
    .filter((record) => !project || record.project === project);
}

/** Ultimo ensayo validado (clone/test) del proyecto. */
export async function latestRehearsal(state: string, project: string): Promise<ExperienceRecord | undefined> {
  const records = (await loadExperiences(state, project))
    .filter((r) => r.stage !== 'prod' && r.validated)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return records.at(-1);
}

/** Deriva del origen de PROD respecto al ensayo. Los BLOCKER impiden ejecutar en PROD. */
export function compareFingerprints(
  rehearsal: SourceFingerprint,
  current: SourceFingerprint,
  nodeDeltaPct = 10,
  dbSizeDeltaPct = 10,
): DriftFinding[] {
  const drift: DriftFinding[] = [];
  if (rehearsal.version !== current.version) {
    drift.push({
      kind: 'VERSION',
      severity: 'BLOCKER',
      detail: `version origen ${current.version} != ensayada ${rehearsal.version}`,
    });
  }
  if (rehearsal.referenceVersion !== current.referenceVersion) {
    drift.push({
      kind: 'REFERENCE_VERSION',
      severity: 'WARN',
      detail: `referencia esquema ${current.referenceVersion} != ensayada ${rehearsal.referenceVersion}`,
    });
  }
  if (!current.schemaHealthy || current.schemaMismatches > 0) {
    drift.push({
      kind: 'SCHEMA_DEFECT',
      severity: 'BLOCKER',
      detail: `esquema actual con defecto (${current.schemaMismatches} discrepancias PK/UNIQUE)`,
    });
  }
  if (current.replicationObjects > 0) {
    drift.push({
      kind: 'REPLICATION',
      severity: 'BLOCKER',
      detail: `replicacion logica (CDC) activa: ${current.replicationObjects} objetos (riesgo de duplicados)`,
    });
  }
  const delta = (a: number, b: number): number => (b === 0 ? 0 : Math.abs(a - b) / b * 100);
  const nodeDelta = delta(current.nodes, rehearsal.nodes);
  if (nodeDelta > nodeDeltaPct) {
    drift.push({ kind: 'NODE_COUNT', severity: 'WARN', detail: `nodos ${current.nodes} vs ${rehearsal.nodes} (${nodeDelta.toFixed(1)}%)` });
  }
  const sizeDelta = delta(current.dbSizeBytes, rehearsal.dbSizeBytes);
  if (sizeDelta > dbSizeDeltaPct) {
    drift.push({ kind: 'DB_SIZE', severity: 'WARN', detail: `tamano BD ${current.dbSizeBytes} vs ${rehearsal.dbSizeBytes} (${sizeDelta.toFixed(1)}%)` });
  }
  return drift;
}

export function hasBlockingDrift(drift: DriftFinding[]): boolean {
  return drift.some((d) => d.severity === 'BLOCKER');
}
