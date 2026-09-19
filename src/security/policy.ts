/**
 * Seguridad ENCAPSULADA en el arnes (no en un core externo).
 *
 * - Politica `tools/pre-execute`: las tools del migrador se permiten (read-only) o se marcan `ask`
 *   (escritura en destino, requiere aprobacion humana). Tools desconocidas con prefijo del plugin: deny.
 * - Guard monotono: el ORIGEN es inmutable; ninguna operacion de escritura puede nombrarlo.
 *
 * La aprobacion real la provee el servicio de approval de `dsh-base`; aqui solo se decide allow/ask/deny.
 */

export const READ_ONLY_TOOLS = [
  'migrator_upgrade_path',
  'migrator_schema_versions',
  'migrator_schema_check',
  'migrator_recommendations',
  'migrator_status',
] as const;

// Tools de escritura: actuan SOLO sobre el destino; requieren aprobacion explicita.
export const WRITE_TOOLS = ['migrator_target', 'migrator_execute'] as const;

const KNOWN = new Set<string>([...READ_ONLY_TOOLS, ...WRITE_TOOLS]);

interface ToolExec {
  name: string;
  arguments?: unknown;
}

interface AskDecision {
  kind: 'ask';
  reason: string;
}
interface DenyDecision {
  kind: 'deny';
  reason: string;
}
type Decision = AskDecision | DenyDecision | { kind: 'allow' };

interface LooseTools {
  guard(guard: (exec: ToolExec) => string | undefined): unknown;
}

/** Forma minima del Context de Cordis que necesita la politica (evita acoplarse a tipos rc). */
export interface SecurityContext {
  on(event: 'tools/pre-execute', handler: (exec: ToolExec, next: () => Promise<unknown>) => Promise<Decision>): unknown;
  tools: LooseTools;
}

const isWrite = (name: string): boolean => (WRITE_TOOLS as readonly string[]).includes(name);

/** Decide la politica de una llamada del migrador (exportada para tests). */
export function decide(exec: ToolExec): Decision {
  const name = exec.name;
  if (!name.startsWith('migrator_')) {
    // No es una tool del plugin: se delega en la politica del arnes (bash/fs/...).
    return { kind: 'allow' };
  }
  if (!KNOWN.has(name)) {
    return { kind: 'deny', reason: `Tool desconocida del migrador: ${name}` };
  }
  if (isWrite(name)) {
    return { kind: 'ask', reason: `La tool ${name} puede escribir en el DESTINO; requiere aprobacion` };
  }
  return { kind: 'allow' };
}

/** Guard monotono: bloquea escritura que apunte al origen (inmutable). */
export function guardReason(exec: ToolExec): string | undefined {
  if (!isWrite(exec.name)) return undefined;
  const args = JSON.stringify(exec.arguments ?? {});
  if (/"origin"\s*:\s*true/.test(args) || /MIGRATOR_WRITE_ORIGIN/.test(args)) {
    return 'Origen inmutable: operacion de escritura sobre el origen bloqueada';
  }
  return undefined;
}

export function installSecurity(ctx: SecurityContext): void {
  ctx.on('tools/pre-execute', async (exec, next) => {
    const decision = decide(exec);
    return decision.kind === 'allow' ? ((await next()) as Decision) : decision;
  });
  ctx.tools.guard(guardReason);
}
