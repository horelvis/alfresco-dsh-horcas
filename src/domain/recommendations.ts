/** Recomendaciones respaldadas por documentacion oficial (Hyland/Alfresco), portadas del core. */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import yaml from 'js-yaml';
import { dataDir } from './data-dir.js';

export interface Source {
  title: string;
  url: string;
}

export interface Recommendation {
  code: string;
  title: string;
  actions: string[];
  sources: Source[];
}

interface RecommendationFile {
  recommendations?: Recommendation[];
}

export async function loadRecommendations(): Promise<Recommendation[]> {
  const file = path.join(dataDir(), 'recommendations.yaml');
  const parsed = yaml.load(await readFile(file, 'utf8')) as RecommendationFile;
  return parsed.recommendations ?? [];
}

/** Recomendaciones para un conjunto de codigos de hallazgo (match exacto, prefijo STEP_ y catch-all *). */
export async function forCodes(codes: string[]): Promise<Recommendation[]> {
  const all = await loadRecommendations();
  const byCode = new Map(all.map((r) => [r.code, r]));
  const result = new Map<string, Recommendation>();
  for (const code of codes) {
    const match = byCode.get(code) ?? (code.startsWith('STEP_') ? byCode.get('STEP') : undefined) ?? byCode.get('*');
    if (match) result.set(match.code, match);
  }
  return [...result.values()];
}
