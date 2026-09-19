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

export type ApprovalMode = 'deny' | 'allow' | 'interactive' | 'allowlist';
export type ApprovalOutcome = 'allowed-once' | 'rejected' | 'unavailable';

export interface ApprovalOptions {
  mode: ApprovalMode;
  allow: string[];
}

export interface ApprovalRequest {
  toolName: string;
  reason?: string;
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

export function installApproval(ctx: ApprovalContext, options: ApprovalOptions = optionsFromEnv()): void {
  ctx.on('approval/request', async (request, next) => {
    if (options.mode === 'interactive') {
      if (!process.stdin.isTTY) {
        return 'rejected';
      }
      return (await prompt(request)) ? 'allowed-once' : 'rejected';
    }
    const outcome = decideApproval(request, options);
    return outcome ?? next();
  });
}
