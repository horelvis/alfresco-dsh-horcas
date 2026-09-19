/**
 * Registro durable de EXPERIENCIA de migracion.
 *
 * Una migracion se prueba primero en un clon de produccion / TEST. Ese ensayo no es un evento unico:
 * puede tener VARIOS INTENTOS (p.ej. ejecutas en PRE, falla un paso, restauras y reanudas desde ese
 * punto). Por eso la experiencia es una CAMPANA con `attempts[]` y un punto de reanudacion.
 *
 * Se guarda con el *fingerprint* del origen (version, esquema, inventario) para reutilizarla en PROD:
 * antes de ejecutar en produccion se comprueba que el origen de PROD no ha derivado del clon ensayado.
 *
 * La memoria de sesion del arnes (`dsh`) es conversacional; este es el artefacto de dominio, estructurado
 * y consultable por las tools en cualquier sesion futura.
 */
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';

export type Stage = 'clone' | 'test' | 'prod';
export type AttemptOutcome = 'ok' | 'failed' | 'aborted';

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
  detail?: string;
}

export interface ExperienceFinding {
  code: string;
  severity: string;
  detail?: string;
}

/** Un intento de migracion dentro de una campana de ensayo. */
export interface ExperienceAttempt {
  /** runId del intento (correlaciona con checkpoints.jsonl). */
  id: string;
  at: string;
  outcome: AttemptOutcome;
  /** Paso donde fallo el intento (si fallo). */
  failedStep?: string;
  /** Paso desde el que reanudar (normalmente el que fallo; el resto ya esta OK en checkpoints). */
  resumeFrom?: string;
  steps: ExperienceStep[];
  findings: ExperienceFinding[];
  notes?: string;
}

/** Campana de ensayo de un proyecto en un stage (acumula intentos). */
export interface ExperienceRecord {
  /** project + stage (una campana por proyecto y stage). */
  id: string;
  project: string;
  stage: Stage;
  sourceVersion: string;
  targetVersion: string;
  createdAt: string;
  updatedAt: string;
  /** Fingerprint de referencia (primer intento). */
  fingerprint: SourceFingerprint;
  /** Algun intento termino OK y el esquema era sano. */
  validated: boolean;
  attempts: ExperienceAttempt[];
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

export function campaignId(project: string, stage: Stage): string {
  return `${project}::${stage}`;
}

/**
 * Registra un INTENTO en la campana (project+stage), creandola si no existe. Append-only: cada linea
 * es un snapshot completo de la campana; la ultima gana.
 */
export async function recordAttempt(
  state: string,
  input: {
    project: string;
    stage: Stage;
    sourceVersion: string;
    targetVersion: string;
    fingerprint: SourceFingerprint;
    attempt: ExperienceAttempt;
  },
): Promise<ExperienceRecord> {
  const id = campaignId(input.project, input.stage);
  const existing = (await loadExperiences(state, input.project)).find((r) => r.id === id);
  const attempts = [...(existing?.attempts ?? []), input.attempt];
  const validated = attempts.some((a) => a.outcome === 'ok') && fingerprintValidated(input.fingerprint);
  const record: ExperienceRecord = {
    id,
    project: input.project,
    stage: input.stage,
    sourceVersion: input.sourceVersion,
    targetVersion: input.targetVersion,
    createdAt: existing?.createdAt ?? input.attempt.at,
    updatedAt: input.attempt.at,
    fingerprint: existing?.fingerprint ?? input.fingerprint,
    validated,
    attempts,
    notes: input.attempt.notes ?? existing?.notes,
  };
  await mkdir(state, { recursive: true });
  await appendFile(experienceFile(state), JSON.stringify(record) + '\n', 'utf8');
  return record;
}

export async function loadExperiences(state: string, project?: string): Promise<ExperienceRecord[]> {
  let text: string;
  try {
    text = await readFile(experienceFile(state), 'utf8');
  } catch {
    return [];
  }
  const byId = new Map<string, ExperienceRecord>();
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const record = JSON.parse(line) as ExperienceRecord;
    byId.set(record.id, record); // append-only: la ultima linea gana
  }
  return [...byId.values()].filter((record) => !project || record.project === project);
}

/** Ultima campana validada de ensayo (clone/test) del proyecto. */
export async function latestRehearsal(state: string, project: string): Promise<ExperienceRecord | undefined> {
  const records = (await loadExperiences(state, project))
    .filter((r) => r.stage !== 'prod' && r.validated)
    .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
  return records.at(-1);
}

/** Punto de reanudacion: paso del ultimo intento fallido que hay que reintentar. */
export function resumePoint(record: ExperienceRecord | undefined): string | undefined {
  if (!record) return undefined;
  const failed = [...record.attempts].reverse().find((a) => a.outcome === 'failed' || a.outcome === 'aborted');
  return failed?.resumeFrom ?? failed?.failedStep;
}

/** Historial de intentos (outcome + paso fallido) para razonar sobre la campana. */
export function attemptSummary(record: ExperienceRecord): string {
  return record.attempts
    .map((a, i) => `#${i + 1} ${a.at} ${a.outcome}${a.failedStep ? ` (fallo en ${a.failedStep}, reanudar en ${a.resumeFrom ?? a.failedStep})` : ''}`)
    .join('\n');
}

export function fingerprintValidated(fingerprint: SourceFingerprint): boolean {
  return fingerprint.schemaHealthy && fingerprint.schemaMismatches === 0 && fingerprint.replicationObjects === 0;
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
  const delta = (a: number, b: number): number => (b === 0 ? 0 : (Math.abs(a - b) / b) * 100);
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
