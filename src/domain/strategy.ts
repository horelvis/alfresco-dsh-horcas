/**
 * Selector de estrategia por perfil de documentos (portado de RuleBasedStrategySelector, docs/design/07).
 * Decide estrategia de contenido (C1-C5), BD (D1/D2) e indice (I1/I2) y explica el porque.
 */

export type ContentStrategy = 'C1_SNAPSHOT' | 'C2_BULK_DELTA' | 'C3_PARALLEL_STREAM' | 'C4_API_CMIS' | 'C5_EXPORT_IMPORT';
export type DbStrategy = 'D1_SNAPSHOT' | 'D2_DUMP_RESTORE' | 'D3_CDC';
export type IndexStrategy = 'I1_FULL_BY_ID' | 'I2_STANDARD';
export type Confidence = 'LOW' | 'MEDIUM' | 'HIGH';

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

const MB = 1_000_000;
const GB = 1_000_000_000;

export function recommendStrategy(input: StrategyInput): StrategyRecommendation {
  const average = input.fileCount > 0 ? Math.floor(input.sizeBytes / input.fileCount) : 0;
  const alternatives: string[] = [];
  const discarded: string[] = [];

  let content: ContentStrategy;
  let rationale: string;
  if (input.fileCount > 1_000_000) {
    content = input.storageAccess ? 'C1_SNAPSHOT' : 'C2_BULK_DELTA';
    rationale = `Volumen alto (${input.fileCount} documentos): cuello en operaciones por fichero`;
    alternatives.push('C1 snapshot si hay acceso al almacenamiento');
    if (!input.storageAccess) {
      discarded.push('C4 API/CMIS (inviable por numero de documentos)');
    }
  } else if (average > 100 * MB) {
    content = 'C3_PARALLEL_STREAM';
    rationale = `Pocos documentos muy grandes (media ${Math.floor(average / MB)} MB): limitado por ancho de banda`;
    alternatives.push('C1 snapshot');
  } else if (input.fileCount < 100_000 && input.sizeBytes < 200 * GB) {
    content = input.transformRequired ? 'C4_API_CMIS' : 'C5_EXPORT_IMPORT';
    rationale = 'Repositorio pequeno/heterogeneo: export/import o API';
  } else {
    content = 'C2_BULK_DELTA';
    rationale = 'Perfil mixto: copia bulk + delta';
  }

  const db: DbStrategy = input.storageAccess ? 'D1_SNAPSHOT' : 'D2_DUMP_RESTORE';
  const index: IndexStrategy = input.nodes > 1_000_000 ? 'I1_FULL_BY_ID' : 'I2_STANDARD';
  const confidence: Confidence = input.storageAccess ? 'MEDIUM' : 'LOW';

  return { content, db, index, rationale, alternatives, discarded, confidence, levers: ['PARALLELISM', 'PURGE_AUDIT'] };
}
