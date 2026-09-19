/**
 * Orquestacion del schema-upgrade de un hop (E7): arranca el ACS destino y espera a que aplique los
 * schema patches internos. El upgrade real lo hace el propio ACS; aqui se observa el log y se valida.
 *
 * Portado de SchemaUpgradeOrchestrator: marcadores de exito y de error.
 */

export const SUCCESS_MARKERS = ['Database schema version', 'Alfresco started', 'Started RepoServer'];
export const ERROR_MARKERS = ['Schema patch failed', 'FATAL', 'Cannot upgrade database'];

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
