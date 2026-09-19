/**
 * Aritmetica de versiones (sin conocimiento de dominio).
 *
 * La matriz de rutas de upgrade y los gates viven en datos (`data/upgrade-paths.yaml`) y se evaluan en
 * `upgrade-paths.ts`. Aqui solo hay comparacion de versiones: hechos puros, sin hardcode de negocio.
 */

export function parseVersion(version: string): number[] {
  return (version ?? '')
    .split('.')
    .map((part) => Number.parseInt(part.replace(/\D/g, ''), 10))
    .filter((n) => Number.isFinite(n));
}

export function compareTuple(a: number[], b: number[]): number {
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i++) {
    const x = i < a.length ? (a[i] as number) : 0;
    const y = i < b.length ? (b[i] as number) : 0;
    if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

export function compareVersions(a: string, b: string): number {
  return compareTuple(parseVersion(a), parseVersion(b));
}

export function atLeast(version: string, reference: string): boolean {
  return compareVersions(version, reference) >= 0;
}
