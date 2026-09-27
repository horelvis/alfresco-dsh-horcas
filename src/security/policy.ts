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
  // Inventario del despliegue del origen (lectura de ficheros locales) y documento de migracion (estado local).
  'migrator_source_stack',
  // Estado real del destino (solo lectura; contenedor efimero con montaje :ro para carpetas de otros uid).
  'migrator_target_state',
  'migrator_report',
  // Auditoria determinista del estado durable (solo escribe el resultado en `.migrator/audit.jsonl`).
  'migrator_audit',
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
  details.push(
    stage && stage.toLowerCase() === 'prod'
      ? 'Entorno: PRODUCCION (stage=prod; requiere un ensayo validado)'
      : stage
        ? `Entorno: ENSAYO (stage=${stage}; no es produccion)`
        : 'Entorno: no indicado',
  );
  if (a.project) details.push(`Proyecto: ${String(a.project)}`);
  const dryRun = a.execute !== true;
  const mode = dryRun
    ? 'Modo: simulacion (dry-run), no escribe nada'
    : 'Modo: ESCRITURA REAL en el DESTINO';
  if (name === 'migrator_run_steps' && Array.isArray(a.steps)) {
    const steps = a.steps as unknown[];
    details.push(mode);
    details.push(`Pasos (${steps.length}, en orden):`);
    for (const step of steps) {
      const id = String(step);
      details.push(`  - ${id}: ${clean(stepById(id)?.short ?? stepById(id)?.description ?? 'paso')}`);
    }
  } else if ('execute' in a) {
    details.push(mode);
  }
  if (a.delta === true) details.push('Copia incremental (solo cambios)');
  if (a.resume === true) details.push('Reanudar: omite los pasos ya completados');
  if (a.out) details.push(`Salida: ${String(a.out)}`);
  const body =
    name === 'migrator_wizard'
      ? undefined
      : 'El ORIGEN (los datos de partida) no se modifica: todo se hace sobre copias en el DESTINO.';
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

const SHELL_TOOLS = new Set(['bash', 'pwsh', 'shell', 'exec']);
const FILE_WRITE_TOOLS = new Set(['write', 'edit', 'multi_edit', 'apply_patch']);
// docker que MUTA (contenedores, volumenes, imagenes); `ps`/`logs`/`inspect`/`config`/`images` siguen permitidos.
const DOCKER_MUTATION =
  /\bdocker(?:\s+compose\b[^|;&]*?)?\s+(?:up|down|rm|rmi|restart|stop|start|kill|create|run|exec|cp|pull|update|prune|volume\s+(?:rm|prune|create)|network\s+(?:rm|prune|create)|system\s+prune)\b/;
// Mutacion de ficheros/BD en un host REMOTO (dentro de un ssh).
const REMOTE_FILE_MUTATION = /\b(?:rm|mv|cp|chown|chmod|mkdir|tee|truncate|dd|keytool|ln|rsync)\b|\bsed\s+-i\b|\b(?:ALTER|DROP|INSERT|UPDATE|DELETE|TRUNCATE|CREATE)\b|(?:^|[^0-9&=<>\-])>>?(?![=>])\s*(?!\/dev\/null|&)/;

/**
 * Comando de shell que CAMBIA el DESTINO (por ssh) o un stack Docker (el origen vive en el Docker local):
 * esas escrituras solo pueden ir por las tools del migrator (aprobacion, checkpoints, guardas). El
 * diagnostico en solo lectura (logs, ps, inspect, cat, curl) sigue permitido.
 */
/**
 * AUTOPROTECCION: carpetas del propio plugin y del arnes. El agente puede LEERLAS, pero nunca escribir,
 * compilar ni hacer git con efectos en ellas: si pudiera, cambiaria las guardas que lo limitan (cambiar el
 * plugin es trabajo del desarrollador). Se reconocen por su nombre de carpeta (sirve con symlinks/~).
 */
export const PROTECTED_DIRS = ['dsh-alfresco-migrator', 'deepseek-harness', 'alfresco-dsh-horcas'];
const protectedPath = new RegExp(`(^|[\\s"'=:(/~])[^\\s"']*/(${PROTECTED_DIRS.join('|')})(/|["'\\s]|$)`);
const SELF_WRITE =
  /\b(?:npm|pnpm|yarn|npx|tsc|tsdown|node\s+\S*build|rm|mv|cp|rsync|chmod|chown|tee|truncate|touch|ln|mkdir|install)\b|\bsed\s+-i\b|\bgit(?:\s+-[Cc]\s+\S+)*\s+(?:commit|checkout|reset|restore|stash|rebase|merge|pull|push|apply|am|clean|switch)\b|(?:^|[^0-9&=<>\-])>>?(?![=>])\s*(?!\/dev\/null|&)/;

/**
 * Vacía el contenido de los literales entre comillas conservando su estructura (las comillas quedan).
 * El verbo de escritura debe estar FUERA de comillas: dentro de un literal es texto a buscar (p. ej. el
 * patrón de un `grep "…rsync…"`) o datos, no una orden. La ruta protegida se sigue detectando sobre el
 * comando ORIGINAL, así `rm "<plugin>/x"` o `> "<plugin>/x"` no se libran (el verbo va fuera de comillas).
 */
const blankQuoted = (command: string): string => command.replace(/'[^']*'/g, "''").replace(/"[^"]*"/g, '""');

/** Motivo de bloqueo si el comando modifica el plugin o el arnes (autoproteccion). */
export function selfModificationReason(command: string): string | undefined {
  if (!protectedPath.test(command)) return undefined;
  if (!SELF_WRITE.test(blankQuoted(command))) return undefined;
  return 'Autoproteccion: el agente no puede modificar, compilar ni versionar el plugin del migrador ni el arnes (solo leerlos). Si hace falta un cambio o un reinicio, para y avisa al humano.';
}

/** Ruta de fichero (tools write/edit) dentro del plugin o del arnes. */
export function protectedFileReason(file: string): string | undefined {
  return PROTECTED_DIRS.some((d) => file.includes(`/${d}/`)) ? selfModificationReason(`touch ${file}`) : undefined;
}

export function shellMutationReason(command: string): string | undefined {
  const self = selfModificationReason(command);
  if (self) return self;
  const remote = /\b(?:ssh|scp)\b/.test(command);
  if (DOCKER_MUTATION.test(command)) {
    return `Operacion Docker que modifica ${remote ? 'el DESTINO' : 'un stack (el ORIGEN es inmutable)'} por shell: usa migrator_run_steps / migrator_provision`;
  }
  if (remote && (/\bscp\b/.test(command) || REMOTE_FILE_MUTATION.test(command))) {
    return 'Modificacion del DESTINO por ssh: usa las tools del migrator (migrator_run_steps); si no hay paso para ello, para y avisa al humano';
  }
  return undefined;
}

/** Guard monotono: bloquea escritura que apunte al origen (inmutable) y cambios por shell fuera del migrator. */
export function guardReason(exec: ToolExec): string | undefined {
  if (FILE_WRITE_TOOLS.has(exec.name)) {
    const args = exec.arguments as { file_path?: unknown; path?: unknown } | undefined;
    const file = typeof args?.file_path === 'string' ? args.file_path : typeof args?.path === 'string' ? args.path : '';
    return file ? protectedFileReason(file) : undefined;
  }
  if (SHELL_TOOLS.has(exec.name)) {
    const args = exec.arguments as { command?: unknown; script?: unknown } | undefined;
    const command = typeof args?.command === 'string' ? args.command : typeof args?.script === 'string' ? args.script : '';
    return command ? shellMutationReason(command) : undefined;
  }
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
    // Cambios del DESTINO/stacks por shell: denegados siempre (tambien si el guard del registro no ve bash).
    const shell = SHELL_TOOLS.has(exec.name) || FILE_WRITE_TOOLS.has(exec.name) ? guardReason(exec) : undefined;
    if (shell) return { kind: 'deny', reason: shell };
    // Reutilizamos la descripcion registrada de la tool (sin hardcodear el motivo).
    const description = ctx.tools.get?.(exec.name, exec.agent)?.description;
    const stage = isWrite(exec.name) ? await projectStage(exec) : undefined;
    const decision = decide(exec, options, description, stage);
    return decision.kind === 'allow' ? ((await next()) as Decision) : decision;
  });
  ctx.tools.guard(guardReason);
}
