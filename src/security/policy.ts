/**
 * Seguridad ENCAPSULADA en el arnes (no en un core externo).
 *
 * - Politica `tools/pre-execute`: las tools del migrador se permiten (read-only) o se marcan `ask`
 *   (escritura en destino, requiere aprobacion humana). Tools desconocidas con prefijo del plugin: deny.
 * - Guardrail solo-migracion (`MIGRATOR_GUARDRAIL=true`): las tools ajenas al plugin se permiten por
 *   CAPACIDAD (lectura/inspeccion, ejecucion por shell, mutacion de ficheros, orquestacion/multiagente,
 *   preguntas al humano) y se deniega solo la RED arbitraria (web_fetch/web_search). La ejecucion/mutacion
 *   NO se deniega aqui: la gobierna el sandbox del arnes (`DSH_PERMISSION_MODE=read-only`) + aprobacion
 *   `ask`, de modo que toda escritura/borrado requiere confirmacion humana. Extensible con
 *   `MIGRATOR_GUARDRAIL_ALLOW`.
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
  // Memoria durable entre chats y ayuda de arranque (estado local, read-only para origen/destino).
  'migrator_journal',
  'migrator_resume',
  'migrator_help',
  // Lecciones COMPARTIDAS entre proyectos (memoria global).
  'migrator_lessons',
  'migrator_lesson_add',
] as const;

// Tools de escritura: actuan SOLO sobre el destino; requieren aprobacion explicita.
// `migrator_backup` no toca origen ni destino pero ejecuta comandos y crea artefactos: tambien requiere aprobacion.
export const WRITE_TOOLS = ['migrator_target', 'migrator_run_steps', 'migrator_backup', 'migrator_reindex', 'migrator_provision', 'migrator_copy_content', 'migrator_wizard'] as const;

const KNOWN = new Set<string>([...READ_ONLY_TOOLS, ...WRITE_TOOLS]);

import { stepById } from '../domain/steps.js';
import { loadProject } from '../domain/project-config.js';
import { workspaceCwd } from '../infra/session.js';

interface ToolExec {
  name: string;
  arguments?: unknown;
  agent?: unknown;
}

/** Definicion de tool expuesta por el registro (lo que necesitamos para el motivo). */
interface ToolDefinitionLike {
  description?: string;
}

interface AskDecision {
  kind: 'ask';
  /** Linea unica de respaldo (para arneses/UI sin motivo estructurado). */
  reason: string;
  /** Titular corto de la decision. */
  title?: string;
  /** Detalles en lista (un aspecto por entrada). */
  details?: string[];
  /** Texto largo opcional. */
  body?: string;
}
interface DenyDecision {
  kind: 'deny';
  reason: string;
}
type Decision = AskDecision | DenyDecision | { kind: 'allow' };

interface LooseTools {
  guard(guard: (exec: ToolExec) => string | undefined): unknown;
  /** El registro del arnes expone la definicion registrada (description, timeoutMs...). */
  get?(name: string, agent?: unknown): ToolDefinitionLike | undefined;
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
  // Ejecucion/inspeccion por shell: el arnes la gobierna con sandbox `read-only` + aprobacion `ask`,
  // de modo que toda escritura/borrado requiere confirmacion humana (no se deniega aqui).
  'bash',
  'pwsh',
  // Mutacion de ficheros del arnes: misma via (sandbox + aprobacion) para no bloquear la operativa.
  'write',
  'edit',
  'str_replace_editor',
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
  // Consulta de sesiones PREVIAS (contexto de chats anteriores del mismo workspace). Read-only.
  'session_search',
  'session_event_search',
  'session_event_read',
  'session_trace',
  'session_event_trace',
] as const;

/** Sugerencia accionable para una tool denegada por el guardrail. */
const GUARDRAIL_HINT: Record<string, string> = {
  web_fetch: 'en modo migracion no hay acceso web; usa las fuentes oficiales ya incluidas (migrator_recommendations)',
  web_search: 'en modo migracion no hay acceso web; usa migrator_recommendations',
};

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

/** Motivo de aprobacion: titular + detalles + cuerpo, y una linea unica de respaldo. */
export interface WriteReason {
  reason: string;
  title: string;
  details: string[];
  body?: string;
}

/**
 * Construye el motivo reutilizando la **descripcion de la propia tool** (registro del arnes) y, para
 * `run_steps`, la **descripcion de cada paso** del catalogo: sin textos hardcodeados.
 */
export function writeReason(name: string, args: unknown, toolDescription?: string, stage?: string): WriteReason {
  const a = (args ?? {}) as Record<string, unknown>;
  const clean = (value: string): string => value.trim().replace(/\s+/g, ' ').replace(/[.]\s*$/, '');
  const title = toolDescription ? clean(toolDescription) : `La tool ${name} puede escribir en el DESTINO`;
  const details: string[] = [];
  if (stage) {
    details.push(
      stage.toLowerCase() === 'prod'
        ? 'Entorno: PRODUCCION (stage=prod; exige ensayo validado)'
        : `Entorno: ENSAYO (stage=${stage}; NO exige ensayo validado)`,
    );
  }
  if (a.project) details.push(`Proyecto: ${String(a.project)}`);
  const dryRun = a.execute !== true;
  const mode = dryRun ? 'dry-run (no ejecuta nada)' : 'EXECUTE (escribe en el DESTINO)';
  if (name === 'migrator_run_steps' && Array.isArray(a.steps)) {
    details.push(`Modo: ${mode}`);
    for (const step of a.steps as unknown[]) {
      const id = String(step);
      details.push(`${id} — ${clean(stepById(id)?.description ?? 'paso')}`);
    }
  } else if ('execute' in a) {
    details.push(`Modo: ${mode}`);
  }
  if (a.delta === true) details.push('Copia incremental');
  if (a.resume === true) details.push('Reanuda (omite pasos ya OK)');
  if (a.out) details.push(`Salida: ${String(a.out)}`);
  const body = name === 'migrator_wizard' ? undefined : 'El ORIGEN no se modifica.';
  const parts = [`${title}.`, ...details];
  if (body) parts.push(body);
  return { reason: parts.join(' · '), title, details, body };
}

/** Decide la politica de una llamada del migrador (exportada para tests). */
export function decide(exec: ToolExec, options: PolicyOptions = {}, toolDescription?: string, stage?: string): Decision {
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
      const prompt = writeReason(name, exec.arguments, toolDescription, stage);
      return {
        kind: 'ask',
        reason: prompt.reason,
        title: prompt.title,
        details: prompt.details,
        ...(prompt.body !== undefined ? { body: prompt.body } : {}),
      };
    }
    return { kind: 'allow' };
  }
  // Tool ajena al plugin (bash/fs/web/...): se delega, salvo con el guardrail activo.
  if (options.guardrail && !new Set<string>([...GUARDRAIL_ALLOW, ...(options.allowTools ?? [])]).has(name)) {
    const hint = GUARDRAIL_HINT[name];
    return {
      kind: 'deny',
      reason: `Guardrail solo-migracion: la tool '${name}' no esta permitida${hint ? `; ${hint}` : ''}`,
    };
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

/** Stage del proyecto del workspace (para que la aprobacion diga ENSAYO vs PROD). `undefined` si no hay. */
async function projectStage(exec: ToolExec): Promise<string | undefined> {
  try {
    return (await loadProject(undefined, workspaceCwd(exec))).stage;
  } catch {
    return undefined;
  }
}

export function installSecurity(ctx: SecurityContext, options: PolicyOptions = policyOptionsFromEnv()): void {
  ctx.on('tools/pre-execute', async (exec, next) => {
    // Reutilizamos la descripcion registrada de la tool (sin hardcodear el motivo).
    const description = ctx.tools.get?.(exec.name, exec.agent)?.description;
    const stage = isWrite(exec.name) ? await projectStage(exec) : undefined;
    const decision = decide(exec, options, description, stage);
    return decision.kind === 'allow' ? ((await next()) as Decision) : decision;
  });
  ctx.tools.guard(guardReason);
}
