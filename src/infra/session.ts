/**
 * Contexto de ejecucion de una tool: el arnes pasa `ToolRunContext` como segundo argumento de
 * `execute`. De ahi sale el **cwd de la sesion** (el workspace del usuario), que es contra el que
 * deben resolverse las rutas relativas del proyecto — no el `process.cwd()` del servidor.
 */
interface SessionLike {
  agent?: { session?: { header?: { cwd?: string } } };
}

/** cwd de la sesion del usuario; `process.cwd()` solo como fallback. */
export function workspaceCwd(exec: unknown, fallback: string = process.cwd()): string {
  return (exec as SessionLike | undefined)?.agent?.session?.header?.cwd ?? fallback;
}
