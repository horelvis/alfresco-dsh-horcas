/**
 * Selector de estrategia por perfil de documentos (portado de RuleBasedStrategySelector, docs/design/07).
 * Aqui solo se aplican las reglas; los umbrales viven en `data/strategy.yaml`.
 */

export type ContentStrategy = 'C1_SNAPSHOT' | 'C2_BULK_DELTA' | 'C3_PARALLEL_STREAM' | 'C4_API_CMIS' | 'C5_EXPORT_IMPORT';
export type DbStrategy = 'D1_SNAPSHOT' | 'D2_DUMP_RESTORE' | 'D3_CDC';
export type IndexStrategy = 'I1_FULL_BY_ID' | 'I2_STANDARD';
export type Confidence = 'LOW' | 'MEDIUM' | 'HIGH';

import { readFileSync } from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { dataDir } from './data-dir.js';

export interface StrategyInput {
  fileCount: number;
  sizeBytes: number;
  nodes: number;
  storageAccess: boolean;
  transformRequired: boolean;
}

export interface StrategyRecommendation {
  content: ContentStrategy;
  db: DbStrategy;
  index: IndexStrategy;
  rationale: string;
  alternatives: string[];
  discarded: string[];
  confidence: Confidence;
  levers: string[];
}

interface StrategyThresholds {
  manyFiles: number;
  largeAverageBytes: number;
  smallFiles: number;
  smallBytes: number;
  manyNodes: number;
}

let cached: StrategyThresholds | undefined;

function thresholds(): StrategyThresholds {
  if (cached) return cached;
  const file = path.join(dataDir(), 'strategy.yaml');
  const parsed = yaml.load(readFileSync(file, 'utf8')) as { thresholds?: Partial<StrategyThresholds> };
  cached = {
    manyFiles: parsed.thresholds?.manyFiles ?? 1_000_000,
    largeAverageBytes: parsed.thresholds?.largeAverageBytes ?? 100_000_000,
    smallFiles: parsed.thresholds?.smallFiles ?? 100_000,
    smallBytes: parsed.thresholds?.smallBytes ?? 200_000_000_000,
    manyNodes: parsed.thresholds?.manyNodes ?? 1_000_000,
  };
  return cached;
}

export function reloadStrategyThresholds(): void {
  cached = undefined;
}

export function recommendStrategy(input: StrategyInput): StrategyRecommendation {
  const t = thresholds();
  const average = input.fileCount > 0 ? Math.floor(input.sizeBytes / input.fileCount) : 0;
  const alternatives: string[] = [];
  const discarded: string[] = [];

  let content: ContentStrategy;
  let rationale: string;
  if (input.fileCount > t.manyFiles) {
    content = input.storageAccess ? 'C1_SNAPSHOT' : 'C2_BULK_DELTA';
    rationale = `Volumen alto (${input.fileCount} documentos): cuello en operaciones por fichero`;
    alternatives.push('C1 snapshot si hay acceso al almacenamiento');
    if (!input.storageAccess) {
      discarded.push('C4 API/CMIS (inviable por numero de documentos)');
    }
  } else if (average > t.largeAverageBytes) {
    content = 'C3_PARALLEL_STREAM';
    rationale = `Pocos documentos muy grandes (media ${Math.floor(average / 1_000_000)} MB): limitado por ancho de banda`;
    alternatives.push('C1 snapshot');
  } else if (input.fileCount < t.smallFiles && input.sizeBytes < t.smallBytes) {
    content = input.transformRequired ? 'C4_API_CMIS' : 'C5_EXPORT_IMPORT';
    rationale = 'Repositorio pequeno/heterogeneo: export/import o API';
  } else {
    content = 'C2_BULK_DELTA';
    rationale = 'Perfil mixto: copia bulk + delta';
  }

  const db: DbStrategy = input.storageAccess ? 'D1_SNAPSHOT' : 'D2_DUMP_RESTORE';
  const index: IndexStrategy = input.nodes > t.manyNodes ? 'I1_FULL_BY_ID' : 'I2_STANDARD';
  const confidence: Confidence = input.storageAccess ? 'MEDIUM' : 'LOW';

  return { content, db, index, rationale, alternatives, discarded, confidence, levers: ['PARALLELISM', 'PURGE_AUDIT'] };
}
