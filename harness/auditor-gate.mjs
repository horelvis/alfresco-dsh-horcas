/**
 * PUERTA DEL ARNES (Nivel 2): obliga a la auditoria antes de emitir el informe final o de ejecutar el
 * reindex final (corte a PROD). No es una instruccion del prompt: es un gate `tools/pre-execute` que el
 * ejecutor NO puede saltarse.
 *
 * Lee el estado durable del workspace (cwd de la sesion) y exige una auditoria (`migrator_audit`,
 * Nivel 0) con 0 FAIL y POSTERIOR al ultimo checkpoint. Si no la hay, DENIEGA y pide ejecutarla.
 *
 * Se monta como plugin del arnes (capa del perfil o `--patch`), no necesita compilacion.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

export const name = 'migrator-auditor-gate';
export const inject = ['tools'];

const cwdOf = (exec) => exec?.agent?.session?.header?.cwd ?? process.cwd();

function readJsonl(file) {
  try {
    return readFileSync(file, 'utf8')
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return undefined;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

const latestAt = (entries) => entries.reduce((max, e) => (e.at && e.at > max ? e.at : max), '');

function stateDir(cwd, env = process.env) {
  const dir = env.MIGRATOR_STATE ?? '.migrator';
  return path.isAbsolute(dir) ? dir : path.join(cwd, dir);
}

/** Motivo por el que la llamada exige auditoria (o `undefined` si no aplica). */
function gatedReason(exec) {
  if (exec.name === 'migrator_report') return 'emitir el informe final';
  if (exec.name === 'migrator_run_steps') {
    const args = exec.arguments ?? {};
    const steps = Array.isArray(args.steps) ? args.steps : [];
    if (args.execute === true && steps.includes('reindex')) return 'ejecutar el reindex final (corte a PROD)';
  }
  return undefined;
}

export function apply(ctx) {
  ctx.on(
    'tools/pre-execute',
    async (exec, next) => {
      const what = gatedReason(exec);
      if (!what) return next();
      // Solo actua si el plugin EXPONE migrator_audit (Nivel 0). Con un plugin antiguo (sin auditoria)
      // no bloquea: evita dejar el informe sin salida durante un despliegue escalonado.
      if (!ctx.tools?.get?.('migrator_audit')) return next();
      const state = stateDir(cwdOf(exec));
      const audits = readJsonl(path.join(state, 'audit.jsonl'));
      const lastAudit = audits.reduce((best, e) => (!best || (e.at ?? '') >= (best.at ?? '') ? e : best), undefined);
      const lastCheckpointAt = latestAt(readJsonl(path.join(state, 'checkpoints.jsonl')));
      const fresh = lastAudit && (!lastCheckpointAt || (lastAudit.at ?? '') >= lastCheckpointAt);
      if (lastAudit && lastAudit.fails === 0 && fresh) return next();
      const detail = !lastAudit
        ? 'no hay auditoria registrada'
        : lastAudit.fails > 0
          ? `la ultima auditoria tiene ${lastAudit.fails} FAIL`
          : 'la auditoria es anterior al ultimo paso ejecutado';
      return {
        kind: 'deny',
        reason: `Auditoria obligatoria antes de ${what}: ${detail}. Ejecuta migrator_audit, resuelve los FAIL y reintenta.`,
      };
    },
    { prepend: true },
  );
}
