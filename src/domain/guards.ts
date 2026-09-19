/**
 * Guardas de seguridad de escritura (deterministas, no juicio): el migrador NUNCA debe escribir sobre
 * el origen. Antes de cualquier paso que escriba se comprueba que el DESTINO no sea el MISMO que el
 * origen (misma base de datos o mismo content store); si lo es, se aborta.
 *
 * Portado de MigrationGuards.requireDistinctTarget/sameDatabase/sameContentStore.
 */
import type { ProjectConfig } from './project-config.js';

export type GuardRisk = 'SAME_DATABASE' | 'SAME_CONTENT_STORE';

export interface GuardFinding {
  risk: GuardRisk;
  severity: 'BLOCKER';
  detail: string;
}

export interface DistinctTargetAssessment {
  blocked: boolean;
  findings: GuardFinding[];
}

const eq = (a?: string, b?: string): boolean =>
  a !== undefined && b !== undefined && a.trim().length > 0 && a.toLowerCase() === b.toLowerCase();

const normalizePath = (path?: string): string | undefined => path?.replace(/\/+$/, '');

export function sameDatabase(
  a: ProjectConfig['source']['database'],
  b: ProjectConfig['target']['database'],
): boolean {
  if (!a || !b) return false;
  return eq(a.host, b.host) && a.port === b.port && eq(a.name, b.name);
}

interface StoreRef {
  type?: string;
  path?: string;
  bucket?: string;
}

export function sameContentStore(
  a: ProjectConfig['source']['contentStore'],
  b: ProjectConfig['target']['contentStore'],
): boolean {
  const sa = (a ?? {}) as StoreRef;
  const sb = (b ?? {}) as StoreRef;
  if (!a || !b || (sa.type ?? 'FS').toUpperCase() !== (sb.type ?? 'FS').toUpperCase()) {
    return false;
  }
  if ((sa.type ?? 'FS').toUpperCase() === 'FS') {
    return eq(normalizePath(sa.path), normalizePath(sb.path));
  }
  return eq(sa.bucket, sb.bucket);
}

/** Evalua si el destino comparte BD o content store con el origen (BLOCKER). */
export function assessDistinctTarget(project: ProjectConfig): DistinctTargetAssessment {
  const findings: GuardFinding[] = [];
  if (sameDatabase(project.source.database, project.target.database)) {
    findings.push({
      risk: 'SAME_DATABASE',
      severity: 'BLOCKER',
      detail: 'El destino apunta a la MISMA base de datos que el origen; se aborta para no modificarlo',
    });
  }
  if (sameContentStore(project.source.contentStore, project.target.contentStore)) {
    findings.push({
      risk: 'SAME_CONTENT_STORE',
      severity: 'BLOCKER',
      detail: 'El destino apunta al MISMO content store que el origen; se aborta para no modificarlo',
    });
  }
  return { blocked: findings.length > 0, findings };
}

/** Lanza si el destino comparte BD o content store con el origen. */
export function requireDistinctTarget(project: ProjectConfig): void {
  const assessment = assessDistinctTarget(project);
  if (assessment.blocked) {
    throw new Error(`SOURCE_WRITE_GUARD: ${assessment.findings.map((f) => f.detail).join(' | ')}`);
  }
}
