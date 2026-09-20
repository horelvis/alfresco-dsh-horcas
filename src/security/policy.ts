/**
 * Seguridad ENCAPSULADA en el arnes (no en un core externo).
 *
 * - Politica `tools/pre-execute`: las tools del migrador se permiten (read-only) o se marcan `ask`
 *   (escritura en destino, requiere aprobacion humana). Tools desconocidas con prefijo del plugin: deny.
 * - Guardrail solo-migracion (`MIGRATOR_GUARDRAIL=true`): las tools ajenas al plugin se permiten por
 *   CAPACIDAD (lectura e inspeccion, orquestacion/multiagente, preguntas al humano), y se deniegan
 *   las de ejecucion/mutacion (bash/pwsh/escritura/web). Extensible con `MIGRATOR_GUARDRAIL_ALLOW`.
 * - Modo solo-lectura (`MIGRATOR_MODE=readonly`, por defecto): las tools de ESCRITURA del migrador se
 *   DENIEGAN de forma determinista (no depende del prompt); para escribir, `MIGRATOR_MODE=write`.
 * - Guard monotono: el ORIGEN es inmutable; ninguna operacion de escritura puede nombrarlo.
 *
 * La aprobacion real la provee el servicio de approval de `dsh-base`; aqui solo se decide allow/ask/deny.
 */

export const READ_ONLY_TOOLS = [
  'migrator_upgrade_path',
  'migrator_schema_versions',
  'migrator_schema_check',
  'migrator_recommendations',
  'migrator_coherence',
  'migrator_dangling_explain',
  'migrator_assess',
  'migrator_steps_list',
  'migrator_run_status',
  'migrator_strategy',
  'migrator_estimate',
  'migrator_checklist',
  'migrator_jira_export',
  'migrator_review',
  'migrator_mount_check',
  'migrator_validate',
  'migrator_distinct_check',
  'migrator_verify_target',
  // Estado local (no toca origen ni destino): registrar/consultar la experiencia de ensayo.
  'migrator_rehearsal_record',
  'migrator_experience_latest',
  'migrator_environment_parity',
] as const;

// Tools de escritura: actuan SOLO sobre el destino; requieren aprobacion explicita.
// `migrator_backup` no toca origen ni destino pero ejecuta comandos y crea artefactos: tambien requiere aprobacion.
export const WRITE_TOOLS = ['migrator_target', 'migrator_run_steps', 'migrator_backup', 'migrator_reindex', 'migrator_provision', 'migrator_copy_content', 'migrator_wizard'] as const;

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

/**
 * Guardrail solo-migracion: tools ajenas al plugin permitidas por capacidad. El agente (y sus
 * subagentes) pueden LEER/inspeccionar y ORQUESTAR, pero no ejecutar comandos ni escribir ficheros
 * (para eso estan las tools `migrator_*`, que ya encapsulan las guardas).
 */
export const GUARDRAIL_ALLOW = [
  // Lectura / inspeccion (tambien desde subagentes).
  'read',
  'read_image',
  'glob',
  'grep',
  // Orquestacion y utilidades del arnes.
  'subagent',
  'send_message',
  'interrupt_agent',
  'list_subagent_models',
  'todo_write',
  'skill',
  'present',
  'job_list',
  'job_output',
  'job_kill',
  'create_goal',
  'get_goal',
  'update_goal',
  // Via de preguntas al humano.
  'ask_user_question',
] as const;

export interface PolicyOptions {
  /** Guardrail solo-migracion: deniega las tools ajenas fuera de las capacidades permitidas. */
  guardrail?: boolean;
  /** Tools ajenas adicionales permitidas por el usuario (amplia el guardrail). */
  allowTools?: string[];
  /** Solo-lectura (por defecto): deniega las tools de escritura del migrador, sin depender del prompt. */
  readOnly?: boolean;
}

/** Forma minima del Context de Cordis que necesita la politica (evita acoplarse a tipos rc). */
export interface SecurityContext {
  on(event: 'tools/pre-execute', handler: (exec: ToolExec, next: () => Promise<unknown>) => Promise<Decision>): unknown;
  tools: LooseTools;
}

const isWrite = (name: string): boolean => (WRITE_TOOLS as readonly string[]).includes(name);

/** Descripcion legible de cada paso (para el motivo de aprobacion). */
const STEP_DESC: Record<string, string> = {
  'preflight-target': 'conectividad/runtime del DESTINO (ssh/docker/compose)',
  'backup-source-db': 'dump de la BD del ORIGEN (solo lectura del origen)',
  'copy-content': 'copia del content store ORIGEN -> DESTINO',
  'restore-target-db': 'restaura la BD en el DESTINO',
  'schema-upgrade': 'arranca ACS en el DESTINO y aplica schema-upgrade',
  reindex: 'regenera el indice del DESTINO (nunca se migra)',
  'verify-target': 'comprueba la salud del DESTINO',
};

/** Motivo de aprobacion descriptivo para una escritura del migrador (se muestra al humano). */
export function writeReason(name: string, args: unknown): string {
  const a = (args ?? {}) as Record<string, unknown>;
  const project = a.project ? String(a.project) : '(proyecto no indicado)';
  const mode = a.execute === true ? 'EXECUTE (va a escribir)' : 'dry-run (solo planifica)';
  const extra: string[] = [];
  if (a.delta === true) extra.push('copia incremental');
  if (a.resume === true) extra.push('resume');
  const suffix = extra.length ? ` (${extra.join(', ')})` : '';
  switch (name) {
    case 'migrator_backup':
      return `Backup NO destructivo del ORIGEN de "${project}": dump de BD + copia del content store + manifiesto SHA-256 + config [${mode}]. No modifica el origen.`;
    case 'migrator_copy_content':
      return `Copia el content store del ORIGEN al DESTINO de "${project}" [${mode}]${suffix}.`;
    case 'migrator_run_steps': {
      const list = Array.isArray(a.steps) ? (a.steps as unknown[]).map((s) => String(s)) : [];
      const detail = list.length ? list.map((s) => `${s} (${STEP_DESC[s] ?? 'paso'})`).join('; ') : '?';
      return `Proyecto "${project}". Pasos en el DESTINO: ${detail}. ${
        a.execute === true ? 'EXECUTE: escribe en el DESTINO.' : 'dry-run: NO ejecuta ningun comando; solo planifica.'
      } El ORIGEN no se modifica.`;
    }
    case 'migrator_target':
      return `Prepara/provisiona el DESTINO de "${project}" (Compose por hop) [${mode}].`;
    case 'migrator_provision':
      return `Provisiona el DESTINO de "${project}" en Docker Compose [${mode}].`;
    case 'migrator_reindex':
      return `Regenera el indice de busqueda del DESTINO de "${project}" (los indices no se migran) [${mode}]${suffix}.`;
    case 'migrator_wizard':
      return `Escribe el YAML del proyecto "${project}" en "${a.out ? String(a.out) : '(ruta por defecto)'}".`;
    default:
      return `La tool ${name} puede escribir en el DESTINO; requiere aprobacion.`;
  }
}

/** Decide la politica de una llamada del migrador (exportada para tests). */
export function decide(exec: ToolExec, options: PolicyOptions = {}): Decision {
  const name = exec.name;
  if (name.startsWith('migrator_')) {
    if (!KNOWN.has(name)) {
      return { kind: 'deny', reason: `Tool desconocida del migrador: ${name}` };
    }
    if (isWrite(name)) {
      if (options.readOnly) {
        return {
          kind: 'deny',
          reason: `Modo solo-lectura: '${name}' escribe en el DESTINO. Activa MIGRATOR_MODE=write para permitirlo.`,
        };
      }
      return { kind: 'ask', reason: writeReason(name, exec.arguments) };
    }
    return { kind: 'allow' };
  }
  // Tool ajena al plugin (bash/fs/web/...): se delega, salvo con el guardrail activo.
  if (options.guardrail && !new Set<string>([...GUARDRAIL_ALLOW, ...(options.allowTools ?? [])]).has(name)) {
    return { kind: 'deny', reason: `Guardrail solo-migracion: la tool '${name}' no esta permitida` };
  }
  return { kind: 'allow' };
}

/**
 * Opciones desde el entorno:
 * - `MIGRATOR_MODE`: `readonly` (defecto) deniega la escritura del migrador; `write` la permite (con aprobacion).
 * - `MIGRATOR_GUARDRAIL` (alias: `MIGRATOR_STRICT_TOOLS`): activa el guardrail solo-migracion.
 * - `MIGRATOR_GUARDRAIL_ALLOW` (alias: `MIGRATOR_STRICT_ALLOW`): tools extra separadas por comas.
 */
export function policyOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): PolicyOptions {
  const raw = env.MIGRATOR_GUARDRAIL ?? env.MIGRATOR_STRICT_TOOLS ?? '';
  const guardrail = ['true', '1', 'yes', 'on'].includes(raw.toLowerCase());
  const allowTools = (env.MIGRATOR_GUARDRAIL_ALLOW ?? env.MIGRATOR_STRICT_ALLOW ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const readOnly = (env.MIGRATOR_MODE ?? 'readonly').toLowerCase() !== 'write';
  return { guardrail, allowTools, readOnly };
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

export function installSecurity(ctx: SecurityContext, options: PolicyOptions = policyOptionsFromEnv()): void {
  ctx.on('tools/pre-execute', async (exec, next) => {
    const decision = decide(exec, options);
    return decision.kind === 'allow' ? ((await next()) as Decision) : decision;
  });
  ctx.tools.guard(guardReason);
}
