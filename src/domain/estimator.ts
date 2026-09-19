/**
 * Estimador de tiempos por fase (portado de SimpleMigrationEstimator de docs/design/06).
 * Formulas deterministas; la confianza sube cuando hay overrides de throughput medidos.
 */

export type Confidence = 'LOW' | 'MEDIUM' | 'HIGH';
export type Phase = 'ASSESSMENT' | 'PRE_STAGING' | 'CUTOVER' | 'POST_CUTOVER';

export interface EstimationInput {
  contentBytes: number;
  dbBytes: number;
  nodes: number;
  auditCount: number;
  hops: number;
  requiresValidationHops: number;
  parallelism: number;
  changeRatePerDay: number;
  throughputOverrides?: Record<string, number>;
}

export interface PhaseEstimate {
  phase: Phase;
  minutes: number;
  cutover: boolean;
  detail: string;
}

export interface Estimation {
  phases: PhaseEstimate[];
  cutoverMinutes: number;
  totalMinutes: number;
  confidence: Confidence;
  bottleneck: 'SCHEMA_UPGRADE' | 'REINDEX' | 'CONTENT_COPY';
  risks: string[];
  levers: string[];
}

const DEFAULTS = {
  contentCopyMbps: 150,
  dbRestoreMbps: 80,
  reindexNodesPerSec: 400,
};

const hoursToMinutes = (value: number): number => Math.round(value * 60);

export function estimate(input: EstimationInput): Estimation {
  const overrides = input.throughputOverrides ?? {};
  const contentMbps = overrides.contentCopyMbps ?? DEFAULTS.contentCopyMbps;
  const dbMbps = overrides.dbRestoreMbps ?? DEFAULTS.dbRestoreMbps;
  const reindexRate = overrides.reindexNodesPerSec ?? DEFAULTS.reindexNodesPerSec;
  const parallelism = Math.max(1, input.parallelism);
  const hops = input.hops;

  const contentMb = input.contentBytes / 1_000_000;
  const dbMb = input.dbBytes / 1_000_000;

  const contentHours = contentMb / (contentMbps * parallelism) / 3600;
  const dbHours = (dbMb / dbMbps / 3600) * 1.8;
  const preStaging = Math.max(contentHours, dbHours) + 1.5;

  const schemaHours = hops * (0.25 + 0.5 * (input.nodes / 1_000_000) + 0.3 * (input.auditCount / 1_000_000));
  const deltaHours = input.changeRatePerDay * Math.max(contentHours, dbHours);
  const cutover = (deltaHours + schemaHours + 0.5 * hops + 0.5) * 1.2;

  const reindexHours = input.nodes / reindexRate / 3600;
  const postCutover = reindexHours + contentHours * 0.3;

  const phases: PhaseEstimate[] = [
    { phase: 'ASSESSMENT', minutes: 30, cutover: false, detail: 'assessment' },
    { phase: 'PRE_STAGING', minutes: hoursToMinutes(preStaging), cutover: false, detail: 'copia+restore' },
    { phase: 'CUTOVER', minutes: hoursToMinutes(cutover), cutover: true, detail: 'schema-upgrade' },
    { phase: 'POST_CUTOVER', minutes: hoursToMinutes(postCutover), cutover: false, detail: 'reindex+verify' },
  ];

  const bottleneck: Estimation['bottleneck'] =
    schemaHours >= Math.max(contentHours, reindexHours) ? 'SCHEMA_UPGRADE' : reindexHours >= contentHours ? 'REINDEX' : 'CONTENT_COPY';

  const risks: string[] = [];
  if (input.auditCount > 100_000_000) {
    risks.push(`Auditoria muy elevada (${input.auditCount}): encarece el schema upgrade`);
  }
  if (input.requiresValidationHops > 0) {
    risks.push(`${input.requiresValidationHops} hop(s) REQUIRES_VALIDATION`);
  }

  const confidence: Confidence = Object.keys(overrides).length > 0 ? 'HIGH' : 'LOW';

  return {
    phases,
    cutoverMinutes: hoursToMinutes(cutover),
    totalMinutes: hoursToMinutes(0.5 + preStaging + cutover + postCutover),
    confidence,
    bottleneck,
    risks,
    levers: ['PURGE_AUDIT', 'PARALLELISM', 'SHARED_CONTENT_STORE'],
  };
}
