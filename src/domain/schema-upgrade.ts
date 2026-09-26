/**
 * Orquestacion del schema-upgrade de un hop (E7): arranca el ACS destino y espera a que aplique los
 * schema patches internos. El upgrade real lo hace el propio ACS; aqui se observa el log y se valida.
 *
 * Portado de SchemaUpgradeOrchestrator: marcadores de exito y de error.
 */
import { sameMinor } from './hops.js';

export const SUCCESS_MARKERS = ['Database schema version', 'Alfresco started', 'Started RepoServer'];
export const ERROR_MARKERS = [
  'Schema patch failed',
  'FATAL',
  'Cannot upgrade database',
  // Fallos de ARRANQUE (no de esquema): sin ellos el paso esperaba al timeout sin diagnostico.
  'Context initialization failed',
  'startup failed due to previous errors',
  'Application startup failed',
  'DictionaryException',
];

/**
 * Extracto del log alrededor del PRIMER marcador de error (causa raiz incluida: las lineas `Caused by`
 * mas profundas), acotado para el detalle del paso. `undefined` si no hay error.
 */
export function errorExcerpt(log: string, maxChars = 1500): string | undefined {
  // Sin el prefijo de compose (`alfresco-1  | `) ni los frames de pila (`at ...`): solo mensajes utiles.
  const lines = log
    .split('\n')
    .map((line) => line.replace(/^\S+-\d+\s+\|\s?/, '').trim())
    .filter((line) => line && !/^at\s/.test(line) && !/^\.\.\. \d+ (more|common frames)/.test(line));
  const index = lines.findIndex((line) => ERROR_MARKERS.some((m) => line.includes(m)));
  if (index < 0) return undefined;
  // La CAUSA RAIZ primero (ultimas `Caused by`), luego el error y su contexto inmediato.
  const causes = lines.filter((line) => /Caused by:/.test(line)).slice(-3);
  const around = lines.slice(index, index + 3);
  const text = [...(causes.length ? ['causa raiz:', ...causes] : []), 'error:', ...around].join(' | ');
  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
}

export function firstContaining(text: string, markers: string[]): string | undefined {
  return markers.find((marker) => text.includes(marker));
}

export interface UpgradeProbeResult {
  hopVersion: string;
  applied: boolean;
  marker?: string;
  error?: string;
}

/** Evalua el log del ACS destino para un hop. */
export function evaluateUpgradeLog(hopVersion: string, log: string): UpgradeProbeResult {
  const error = firstContaining(log, ERROR_MARKERS);
  if (error) {
    return { hopVersion, applied: false, error };
  }
  const marker = firstContaining(log, SUCCESS_MARKERS);
  return marker ? { hopVersion, applied: true, marker } : { hopVersion, applied: false };
}

export interface UpgradeWaitOptions {
  timeoutMs: number;
  intervalMs: number;
  sleep?: (ms: number) => Promise<void>;
}

/** Espera (con sondeo) a que el log del hop muestre exito o error. */
export async function waitForUpgrade(
  hopVersion: string,
  probe: () => Promise<string>,
  options: UpgradeWaitOptions,
): Promise<UpgradeProbeResult> {
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const start = Date.now();
  let last: UpgradeProbeResult = { hopVersion, applied: false };
  while (Date.now() - start < options.timeoutMs) {
    last = evaluateUpgradeLog(hopVersion, await probe());
    if (last.applied || last.error) return last;
    await sleep(options.intervalMs);
  }
  return last;
}

export interface SmokeInput {
  /** Version del hop que se acaba de arrancar (p.ej. 7.4). */
  hop: string;
  /** Version que reporta el DESTINO (discovery); `undefined` si no respondio. */
  version?: string;
  /** Codigo HTTP de `nodes/-root-`. */
  rootCode: string;
  /** Cola del log del servicio alfresco. */
  log: string;
}

export interface SmokeResult {
  ok: boolean;
  reason?: string;
}

/**
 * Smoke test del hop (fail-closed): el DESTINO responde EN LA VERSION DEL HOP, la raiz resuelve (app y BD
 * alineadas) y el log no muestra errores de esquema. Es lo que autoriza a registrar el hop como hecho.
 */
export function evaluateSmoke(input: SmokeInput): SmokeResult {
  const error = firstContaining(input.log, ERROR_MARKERS);
  if (error) return { ok: false, reason: `error en el log de alfresco: ${error}` };
  if (!input.version) return { ok: false, reason: 'no se pudo leer la version del DESTINO (discovery)' };
  if (!sameMinor(input.version, input.hop)) {
    return { ok: false, reason: `el DESTINO responde en ${input.version} y el hop es ${input.hop}` };
  }
  if (!input.rootCode.startsWith('2')) {
    return { ok: false, reason: `la raiz no resuelve (http=${input.rootCode || 'sin respuesta'}): app y BD desalineadas` };
  }
  return { ok: true };
}
