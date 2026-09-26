/**
 * Redaccion de SECRETOS en la salida de TODAS las tools (tambien `bash`/`read`/`grep`, no solo las
 * `migrator_*`): un listener `tools/post-execute` reemplaza el contenido antes de que llegue al LLM, y
 * `tools/ptc-dispatch-log` hace lo mismo con la copia del log durable de las sub-llamadas.
 *
 * Dos capas, deterministas:
 * 1. VALORES conocidos: los del `stack.env` del migrator (contraseñas generadas del stack) y las
 *    variables de entorno con nombre de secreto (`*PASSWORD*`, `*SECRET*`, `*TOKEN*`, `*API_KEY*`...).
 * 2. PATRONES: `password=...`, `PGPASSWORD='...'`, `POSTGRES_PASSWORD: ...`, `user:pass@host`...
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { stateDir } from '../domain/experience.js';
import { workspaceCwd } from '../infra/session.js';

export const MASK = '***';

const SECRET_NAME = /(pass(word|wd)?|pwd|secret|token|api[_-]?key|credential|private[_-]?key)/i;

/**
 * Un valor se trata como secreto a enmascarar si es lo bastante largo y no es una palabra trivial
 * (`admin`/`alfresco` son valores por defecto documentados: enmascararlos destrozaria la salida).
 */
export function isMaskableValue(value: string): boolean {
  return value.length >= 8 && /[^a-z]/i.test(value);
}

/** Secretos por VALOR: variables de entorno con nombre de secreto. */
export function envSecrets(env: NodeJS.ProcessEnv = process.env): string[] {
  return Object.entries(env)
    .filter(([key, value]) => SECRET_NAME.test(key) && typeof value === 'string')
    .map(([, value]) => (value as string).trim());
}

/** Secretos por VALOR de un fichero `KEY=VALUE` (el `stack.env` del migrator). */
export function parseEnvFile(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#') && line.includes('='))
    .filter((line) => SECRET_NAME.test(line.slice(0, line.indexOf('='))))
    .map((line) => line.slice(line.indexOf('=') + 1).trim().replace(/^['"]|['"]$/g, ''));
}

function stackSecrets(cwd: string): string[] {
  try {
    return parseEnvFile(readFileSync(path.resolve(cwd, stateDir(), 'provision', 'stack.env'), 'utf8'));
  } catch {
    return [];
  }
}

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Valor tras `clave=`/`clave: `: hasta blanco, comilla o separador (no rompe JSON ni YAML).
const VALUE = String.raw`[^\s"'\x60,;&]+`;
const PATTERNS: Array<[RegExp, string]> = [
  // KEY=valor | KEY: valor | KEY='valor' (clave con nombre de secreto: db.password, PGPASSWORD, -Dx.password...)
  [new RegExp(String.raw`([\w.\-]*(?:pass(?:word|wd)?|pwd|secret|token|api[_-]?key)[\w.\-]*["']?\s*[=:]\s*["']?)(${VALUE})`, 'gi'), `$1${MASK}`],
  // Credenciales en URL: scheme://user:pass@host
  [/(\b[a-z][\w+.-]*:\/\/[^\s:/@]+:)([^\s@/]+)(@)/gi, `$1${MASK}$3`],
];

/** Enmascara los secretos de `text` (valores conocidos + patrones). */
export function redactText(text: string, secrets: string[]): string {
  let out = text;
  const values = [...new Set(secrets.filter(isMaskableValue))].sort((a, b) => b.length - a.length);
  for (const value of values) out = out.replace(new RegExp(escapeRegExp(value), 'g'), MASK);
  for (const [pattern, replacement] of PATTERNS) {
    out = out.replace(pattern, (match, ...groups) => {
      // No re-enmascarar lo ya enmascarado ni valores triviales (password=admin sigue legible).
      const value = String(groups[1] ?? '');
      if (value === MASK || !isMaskableValue(value)) return match;
      return replacement.replace('$1', String(groups[0])).replace('$3', String(groups[2] ?? ''));
    });
  }
  return out;
}

interface TextBlock {
  type: string;
  text?: string;
}

/** Redacta los bloques de texto; devuelve `undefined` si no cambio nada. */
export function redactBlocks<T extends TextBlock>(blocks: readonly T[], secrets: string[]): T[] | undefined {
  let changed = false;
  const out = blocks.map((block) => {
    if (block.type !== 'text' || typeof block.text !== 'string') return block;
    const text = redactText(block.text, secrets);
    if (text === block.text) return block;
    changed = true;
    return { ...block, text };
  });
  return changed ? out : undefined;
}

type Decision = { kind: string; content?: TextBlock[]; value?: unknown; [key: string]: unknown };

export interface RedactContext {
  on(
    event: 'tools/post-execute',
    handler: (exec: unknown, result: { content?: TextBlock[] }, next: () => Promise<Decision>) => Promise<Decision>,
    options?: { prepend?: boolean },
  ): unknown;
  on(event: 'tools/ptc-dispatch-log', handler: (dispatch: { exec?: unknown }, next: () => Promise<TextBlock[]>) => Promise<TextBlock[]>): unknown;
}

export function installRedaction(ctx: RedactContext): void {
  const secretsFor = (exec: unknown): string[] => [...envSecrets(), ...stackSecrets(workspaceCwd(exec))];

  ctx.on(
    'tools/post-execute',
    async (exec, result, next) => {
      const decision = await next();
      if (decision.kind !== 'accept') return decision;
      const secrets = secretsFor(exec);
      if (Object.hasOwn(decision, 'value')) {
        // Valor estructurado: se redacta su serializacion (el patron nunca rompe comillas JSON).
        const json = JSON.stringify(decision.value);
        const redacted = json === undefined ? json : redactText(json, secrets);
        if (redacted === json || redacted === undefined) return decision;
        try {
          return { ...decision, value: JSON.parse(redacted) };
        } catch {
          return decision;
        }
      }
      const content = decision.content ?? result.content;
      const replaced = content ? redactBlocks(content, secrets) : undefined;
      return replaced ? { ...decision, content: replaced } : decision;
    },
    // prepend: envuelve al resto de listeners (spill incluido) y redacta lo que finalmente se acepte.
    { prepend: true },
  );

  ctx.on('tools/ptc-dispatch-log', async (dispatch, next) => {
    const content = await next();
    return redactBlocks(content, secretsFor(dispatch.exec)) ?? content;
  });
}
