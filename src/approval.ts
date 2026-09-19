/**
 * Answerer de APROBACION real para el arnes (headless incluido).
 *
 * El waterfall `approval/request` recibe {agent, toolName, callId?, reason?} y debe devolver
 * 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'. Sin answerer, el arnes falla en cerrado.
 *
 * Modos (`MIGRATOR_APPROVAL`):
 * - `deny` (defecto): rechaza toda escritura (fail-closed).
 * - `allowlist`: permite solo las tools de `MIGRATOR_APPROVAL_ALLOW` (coma-separadas).
 * - `interactive`: pregunta por stdin (solo si hay TTY); sin TTY rechaza.
 * - `allow`: concede todo (solo entornos de confianza/CI).
 *
 * Nota: el evento no expone los argumentos de la tool (solo nombre y motivo), por eso la allowlist
 * es por nombre; la granularidad por argumentos la impone el guard del plugin.
 */
import { createInterface } from 'node:readline/promises';
import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

export type ApprovalMode = 'deny' | 'allow' | 'interactive' | 'allowlist';
export type ApprovalOutcome = 'allowed-once' | 'rejected' | 'unavailable';

/** El arnes solo admite concesiones one-shot; este guard lo hace explicito y testable. */
export const PERSISTENT_GRANTS: readonly string[] = ['always', 'allow-always', 'remember', 'session', 'persist'];
export function assertOneShot(outcome: ApprovalOutcome): ApprovalOutcome {
  if ((PERSISTENT_GRANTS as readonly string[]).includes(outcome)) {
    throw new Error(`El arnes no admite concesiones persistentes: ${outcome}`);
  }
  return outcome;
}

export interface ApprovalOptions {
  mode: ApprovalMode;
  allow: string[];
}

export interface ApprovalRequest {
  toolName: string;
  reason?: string;
  agent?: ApprovalAgent;
}

/** Identidad minima del agente (dsh Agent): permite rechazar aprobaciones heredadas por subagentes. */
export interface ApprovalAgent {
  parentAgent?: ApprovalAgent;
  meta?: { origin?: string; delegationDepth?: number };
}

/**
 * `true` si el agente es un subagente (delegado). El arnes propaga la politica de aprobacion a los
 * hijos (`approval/policy` con `source: 'delegation'`), de modo que un answerer global responderia
 * tambien por ellos: eso es exactamente una "autorizacion heredada en cadena". La bloqueamos.
 */
export function isDelegated(agent: ApprovalAgent | undefined): boolean {
  if (!agent) return false;
  if (agent.parentAgent) return true;
  if (agent.meta?.origin === 'subagent') return true;
  return (agent.meta?.delegationDepth ?? 0) > 0;
}

export function optionsFromEnv(env: NodeJS.ProcessEnv = process.env): ApprovalOptions {
  const mode = (env.MIGRATOR_APPROVAL ?? 'deny').toLowerCase();
  const valid: ApprovalMode[] = ['deny', 'allow', 'interactive', 'allowlist'];
  return {
    mode: (valid.includes(mode as ApprovalMode) ? mode : 'deny') as ApprovalMode,
    allow: (env.MIGRATOR_APPROVAL_ALLOW ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  };
}

/** Decide en funcion del modo. `undefined` = delegar en el siguiente answerer. */
export function decideApproval(
  request: ApprovalRequest,
  options: ApprovalOptions,
  interactiveAnswer?: (request: ApprovalRequest) => Promise<boolean>,
): ApprovalOutcome | undefined {
  switch (options.mode) {
    case 'allow':
      return 'allowed-once';
    case 'allowlist':
      return options.allow.includes(request.toolName) ? 'allowed-once' : 'rejected';
    case 'interactive':
      return interactiveAnswer ? undefined : 'rejected';
    case 'deny':
    default:
      return 'rejected';
  }
}

async function prompt(request: ApprovalRequest): Promise<boolean> {
  if (!process.stdin.isTTY) {
    return false;
  }
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await rl.question(
      `\n[aprobacion] ${request.toolName}${request.reason ? ` — ${request.reason}` : ''}\n¿Permitir? [y/N] `,
    );
    return answer.trim().toLowerCase() === 'y' || answer.trim().toLowerCase() === 'yes';
  } finally {
    rl.close();
  }
}

export interface ApprovalContext {
  on(event: 'approval/request', handler: (request: ApprovalRequest, next: () => Promise<ApprovalOutcome>) => Promise<ApprovalOutcome | undefined>): unknown;
}

/** Registro durable de cada decision de aprobacion (auditoria; el arnes no guarda grants). */
export interface ApprovalAuditEntry {
  at: string;
  toolName: string;
  reason?: string;
  mode: ApprovalMode;
  outcome: ApprovalOutcome;
}

export function approvalAuditFile(state: string): string {
  return path.join(state, 'approvals.jsonl');
}

async function audit(entry: ApprovalAuditEntry): Promise<void> {
  const state = process.env.MIGRATOR_STATE ?? '.migrator';
  try {
    await mkdir(state, { recursive: true });
    await appendFile(approvalAuditFile(state), JSON.stringify(entry) + '\n', 'utf8');
  } catch {
    // La auditoria nunca debe romper la aprobacion.
  }
}

/**
 * El arnes NO admite un outcome persistente ("always"/"remember"): `allowed-once` es la unica
 * concesion y aplica solo a la accion pedida. La durabilidad por tool vive en nuestro answerer
 * (`MIGRATOR_APPROVAL=allowlist|allow`), no en un grant de sesion. Aqui ademas auditamos cada decision.
 *
 * IMPORTANTE: el answerer es global, asi que SOLO decide sobre nuestras tools (`migrator_*`); para el
 * resto delega en `next()` (answerer de la UI en `web`, o fail-closed del arnes). Asi no bloqueamos
 * `bash`/`write` de subagentes ni pisamos la aprobacion interactiva del perfil web.
 */
export function installApproval(ctx: ApprovalContext, options: ApprovalOptions = optionsFromEnv()): void {
  ctx.on('approval/request', async (request, next) => {
    // No es una tool del migrador: que decida el arnes/la UI.
    if (!request.toolName.startsWith('migrator_')) {
      return next();
    }
    // Nunca autorizar por herencia: las escrituras del migrador delegadas a subagentes se rechazan.
    if (isDelegated(request.agent)) {
      await audit({ at: new Date().toISOString(), toolName: request.toolName, reason: request.reason, mode: options.mode, outcome: 'rejected' });
      return 'rejected';
    }
    let outcome: ApprovalOutcome;
    if (options.mode === 'interactive') {
      if (!process.stdin.isTTY) {
        outcome = 'rejected';
      } else {
        outcome = (await prompt(request)) ? 'allowed-once' : 'rejected';
      }
    } else {
      outcome = decideApproval(request, options) ?? (await next());
    }
    await audit({ at: new Date().toISOString(), toolName: request.toolName, reason: request.reason, mode: options.mode, outcome });
    return assertOneShot(outcome);
  });
}
