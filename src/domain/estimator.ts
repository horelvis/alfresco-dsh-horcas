/**
 * Estimador de tiempos por fase (portado de SimpleMigrationEstimator de docs/design/06).
 * Aqui solo hay ARITMETICA: los parametros/umbrales viven en `data/estimation.yaml`.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { dataDir } from './data-dir.js';

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

interface EstimationData {
  throughput: { contentCopyMbps: number; dbRestoreMbps: number; reindexNodesPerSec: number };
  factors: Record<string, number>;
  thresholds: { auditHigh: number };
  levers: string[];
}

let cached: EstimationData | undefined;

function data(): EstimationData {
  if (cached) return cached;
  const file = path.join(dataDir(), 'estimation.yaml');
  const parsed = yaml.load(readFileSync(file, 'utf8')) as Partial<EstimationData>;
  cached = {
    throughput: parsed.throughput ?? { contentCopyMbps: 150, dbRestoreMbps: 80, reindexNodesPerSec: 400 },
    factors: parsed.factors ?? {},
    thresholds: parsed.thresholds ?? { auditHigh: 100_000_000 },
    levers: parsed.levers ?? [],
  };
  return cached;
}

export function reloadEstimation(): void {
  cached = undefined;
}

const hoursToMinutes = (value: number): number => Math.round(value * 60);

export function estimate(input: EstimationInput): Estimation {
  const d = data();
  const f = d.factors;
  const overrides = input.throughputOverrides ?? {};
  const contentMbps = overrides.contentCopyMbps ?? d.throughput.contentCopyMbps;
  const dbMbps = overrides.dbRestoreMbps ?? d.throughput.dbRestoreMbps;
  const reindexRate = overrides.reindexNodesPerSec ?? d.throughput.reindexNodesPerSec;
  const parallelism = Math.max(1, input.parallelism);
  const hops = input.hops;

  const contentMb = input.contentBytes / 1_000_000;
  const dbMb = input.dbBytes / 1_000_000;

  const contentHours = contentMb / (contentMbps * parallelism) / 3600;
  const dbHours = (dbMb / dbMbps / 3600) * (f.dbRestoreFactor ?? 1.8);
  const preStaging = Math.max(contentHours, dbHours) + (f.preStagingOverheadHours ?? 1.5);

  const schemaHours = hops * ((f.schemaBaseHoursPerHop ?? 0.25) + (f.schemaNodeFactor ?? 0.5) * (input.nodes / 1_000_000) + (f.schemaAuditFactor ?? 0.3) * (input.auditCount / 1_000_000));
  const deltaHours = input.changeRatePerDay * Math.max(contentHours, dbHours);
  const cutover = (deltaHours + schemaHours + (f.cutoverHoursPerHop ?? 0.5) * hops + (f.cutoverBaseHours ?? 0.5)) * (f.cutoverSafetyFactor ?? 1.2);

  const reindexHours = input.nodes / reindexRate / 3600;
  const postCutover = reindexHours + contentHours * (f.postCutoverContentFactor ?? 0.3);

  const phases: PhaseEstimate[] = [
    { phase: 'ASSESSMENT', minutes: f.assessmentMinutes ?? 30, cutover: false, detail: 'assessment' },
    { phase: 'PRE_STAGING', minutes: hoursToMinutes(preStaging), cutover: false, detail: 'copia+restore' },
    { phase: 'CUTOVER', minutes: hoursToMinutes(cutover), cutover: true, detail: 'schema-upgrade' },
    { phase: 'POST_CUTOVER', minutes: hoursToMinutes(postCutover), cutover: false, detail: 'reindex+verify' },
  ];

  const bottleneck: Estimation['bottleneck'] =
    schemaHours >= Math.max(contentHours, reindexHours) ? 'SCHEMA_UPGRADE' : reindexHours >= contentHours ? 'REINDEX' : 'CONTENT_COPY';

  const risks: string[] = [];
  if (input.auditCount > d.thresholds.auditHigh) {
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
    levers: [...d.levers],
  };
}

