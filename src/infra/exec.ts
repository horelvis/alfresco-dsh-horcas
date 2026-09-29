/**
 * Ejecutor de comandos con enrutado LOCAL/SSH y overrides por entorno:
 * `MIGRATOR_DB_DUMP_CMD` ({out}), `MIGRATOR_DB_RESTORE_CMD` ({in}), `MIGRATOR_REINDEX_CMD`
 * ({prefixesFile},{dbUrl}). Los comandos de contenedor (docker exec/run) van dentro del override.
 */
import { spawn } from 'node:child_process';

export interface HostRef {
  /** 'local' o un host SSH de `access.hosts`. */
  name: string;
  host?: string;
  user?: string;
  keyFile?: string;
}

export interface ExecResult {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
}

export function substitute(template: string, values: Record<string, string>): string {
  let result = template;
  for (const [key, value] of Object.entries(values)) {
    result = result.replaceAll(`{${key}}`, value);
  }
  return result;
}

function runLocal(command: string, args: string[], stdin?: string | Buffer): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => (stdout += chunk));
    child.stderr?.on('data', (chunk) => (stderr += chunk));
    child.on('error', (error) => resolve({ command: [command, ...args].join(' '), exitCode: 127, stdout, stderr: String(error) }));
    child.on('close', (code) => resolve({ command: [command, ...args].join(' '), exitCode: code ?? -1, stdout, stderr }));
    child.stdin?.end(stdin ?? '');
  });
}

/** Comando + argumentos para ejecutar en el host (local via `sh -c`, remoto via `ssh`). */
function invocation(host: HostRef, command: string): { cmd: string; args: string[] } {
  if (host.name === 'local' || !host.host) {
    return { cmd: 'sh', args: ['-c', command] };
  }
  const args = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10'];
  if (host.keyFile) {
    args.push('-i', host.keyFile);
  }
  args.push(`${host.user ?? 'root'}@${host.host}`, command);
  return { cmd: 'ssh', args };
}

/** Ejecuta un comando shell en el host (local o por SSH). */
export async function runShell(host: HostRef, command: string, signal?: AbortSignal): Promise<ExecResult> {
  const { cmd, args } = invocation(host, command);
  void signal;
  return runLocal(cmd, args);
}

/** Como `runShell`, pero envia `stdin` al proceso (p. ej. `docker compose -f - up -d` con el YAML). */
/** `stdin` binario (Buffer) para artefactos como el dump de `pg_dump -Fc`: NUNCA pasarlos como texto. */
export async function runShellWithInput(host: HostRef, command: string, stdin: string | Buffer, signal?: AbortSignal): Promise<ExecResult> {
  const { cmd, args } = invocation(host, command);
  void signal;
  return runLocal(cmd, args, stdin);
}
