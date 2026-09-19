/**
 * Reglas de ruta de upgrade de Alfresco Content Services (portadas del core Spring).
 * No se inventan rutas: se resuelven contra la matriz oficial.
 */

export type PathClass = 'SUPPORTED' | 'REQUIRES_VALIDATION' | 'UNSUPPORTED';

export interface Hop {
  from: string;
  to: string;
  intermediate: boolean;
  pathClass: PathClass;
  notes: string[];
}

const SEVEN_FOUR: readonly [number, number] = [7, 4];
const TWO_FIVE_THREE: readonly [number, number] = [25, 3];

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

function hop(from: string, to: string, intermediate: boolean, pathClass: PathClass, notes: string[]): Hop {
  return { from, to, intermediate, pathClass, notes };
}

/** Ruta soportada por el fabricante desde `from` hasta `to`. */
export function resolveUpgradePath(fromRaw: string, to: string): Hop[] {
  const from = parseVersion(fromRaw);
  if (compareTuple(from, [...TWO_FIVE_THREE]) >= 0) {
    return [hop(fromRaw, to, false, 'SUPPORTED', [])];
  }
  if (compareTuple(from, [...SEVEN_FOUR]) >= 0) {
    return [
      hop(fromRaw, '25.3', true, 'SUPPORTED', [
        'Java 21 + Tomcat 11',
        'ActiveMQ con autenticacion',
        'eventos v1 deshabilitados',
      ]),
      hop('25.3', to, false, 'SUPPORTED', ['Solr no soportado: regenerar con Search Enterprise']),
    ];
  }
  if (from[0] !== undefined && from[0] >= 7) {
    const first: PathClass = compareTuple(from, [7, 2]) < 0 ? 'REQUIRES_VALIDATION' : 'SUPPORTED';
    const firstNotes = first === 'REQUIRES_VALIDATION' ? ['Upgrade < 7.2: contactar con soporte del fabricante'] : [];
    return [
      hop(fromRaw, '7.4', true, first, firstNotes),
      hop('7.4', '25.3', true, 'SUPPORTED', [
        'Java 21 + Tomcat 11',
        'ActiveMQ con autenticacion',
        'eventos v1 deshabilitados',
      ]),
      hop('25.3', to, false, 'SUPPORTED', ['Solr no soportado: regenerar con Search Enterprise']),
    ];
  }
  if (from[0] === 6) {
    return [
      hop(fromRaw, '7.4', true, 'REQUIRES_VALIDATION', ['Salto 6.x -> 7.4: validar con soporte']),
      hop('7.4', '25.3', true, 'SUPPORTED', ['Java 21 + Tomcat 11']),
      hop('25.3', to, false, 'SUPPORTED', ['Sin Solr: regenerar indice']),
    ];
  }
  if (from[0] === 5) {
    return [
      hop(fromRaw, '6.2', true, 'REQUIRES_VALIDATION', ['Sin multi-tenancy desde 6.x']),
      hop('6.2', '7.4', true, 'REQUIRES_VALIDATION', ['Validar con soporte']),
      hop('7.4', '25.3', true, 'SUPPORTED', ['Java 21 + Tomcat 11']),
      hop('25.3', to, false, 'SUPPORTED', ['Sin Solr: regenerar indice']),
    ];
  }
  return [hop(fromRaw, to, false, 'UNSUPPORTED', ['Ruta no soportada: validar con el fabricante'])];
}

/** Gates de breaking changes aplicables segun la version destino (para la checklist). */
export function breakingChangeGates(targetVersion: string, edition: string): string[] {
  const gates: string[] = [];
  if (atLeast(targetVersion, '25.3')) {
    gates.push('Java 21/Tomcat 10+');
  }
  if (atLeast(targetVersion, '26')) {
    gates.push('ActiveMQ 6.x con autenticacion, eventos v2');
    if (edition === 'EE') {
      gates.push('Solr no soportado (Enterprise)');
    }
  }
  if (gates.length === 0) {
    gates.push(`revisar breaking changes de ${targetVersion}`);
  }
  return gates;
}

/** Requiere desmantelar Solr en el destino (Enterprise >= 26). */
export function requiresSolrRemoval(targetVersion: string, edition: string): boolean {
  return edition === 'EE' && atLeast(targetVersion, '26');
}
