/**
 * RESUMEN de "donde estamos" para retomar en un chat nuevo. La parte de juicio (siguiente accion) es una
 * funcion PURA y testeable; el resto son hechos leidos del estado local y del destino.
 */
import { readdir, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export interface NextActionInput {
  hasProject: boolean;
  hops: number;
  /** Version del hop pendiente (o final si no quedan). */
  hopPending?: string;
  /** `true` si el destino casa con el hop; `false` si no; `undefined` si no verificable. */
  hopOk?: boolean;
  destinationVersion?: string;
  /** Paso desde el que reanudar (ultimo intento fallido). */
  resumeFrom?: string;
  backupComplete: boolean;
}

/** Siguiente accion recomendada (determinista) segun el estado. */
export function nextAction(input: NextActionInput): string {
  if (!input.hasProject) return 'Crea el proyecto del workspace con migrator_wizard.';
  if (input.resumeFrom) return `Reanuda el run desde '${input.resumeFrom}' (migrator_run_steps con resume=true).`;
  if (input.hops > 1) {
    if (input.hopOk === false && input.destinationVersion) {
      return `El DESTINO esta en ${input.destinationVersion} y el hop exige ${input.hopPending}: provisiona esa version y vuelve a comprobar.`;
    }
    if (input.destinationVersion === undefined) {
      return 'No se pudo leer la version del DESTINO: revisa MIGRATOR_DST_BASE_URL y el acceso.';
    }
  }
  if (!input.backupComplete) return 'Backup del origen no completo: ejecuta migrator_backup.';
  return `Haz dry-run del hop ${input.hopPending ?? 'final'} y, tras tu aprobacion, ejecutalo.`;
}

/** Directorio de sesiones del arnes para un workspace (codificacion de dsh: ' ' -> ~0020, '/' -> '-'). */
export function sessionsDirFor(cwd: string, home: string = os.homedir()): string {
  const trimmed = cwd.replace(/^\/+/, '').replace(/\/+$/, '');
  const encoded = trimmed.replace(/ /g, '~0020').replace(/\//g, '-');
  return path.join(home, '.dsh', 'sessions', `--${encoded}--`);
}

/** Ids de sesiones recientes del workspace (mas nuevas primero), para consultar el contexto previo. */
export async function recentSessions(cwd: string, home: string = os.homedir(), limit = 5): Promise<string[]> {
  const dir = sessionsDirFor(cwd, home);
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const sessions: Array<{ id: string; mtime: number }> = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith('session-')) continue;
    try {
      const info = await stat(path.join(dir, entry.name, 'session.v3.jsonl.zstd'));
      sessions.push({ id: entry.name, mtime: info.mtimeMs });
    } catch {
      // sin transcript: se ignora
    }
  }
  return sessions.sort((a, b) => b.mtime - a.mtime).slice(0, limit).map((s) => s.id);
}

export interface BackupStatus {
  present: boolean;
  db: boolean;
  contentStore: boolean;
  config: boolean;
}

/** Comprueba (sin escribir) si hay un backup del origen en `backupDir`. */
export async function backupStatus(backupDir: string, project: string): Promise<BackupStatus> {
  const nonEmptyFile = async (file: string): Promise<boolean> => {
    try {
      const info = await stat(file);
      return info.isFile() && info.size > 0;
    } catch {
      return false;
    }
  };
  const nonEmptyDir = async (dir: string): Promise<boolean> => {
    try {
      return (await readdir(dir)).length > 0;
    } catch {
      return false;
    }
  };
  const db = await nonEmptyFile(path.join(backupDir, 'db', 'alfresco-postgresql.dump'));
  const contentStore = await nonEmptyDir(path.join(backupDir, 'contentstore'));
  const config = await nonEmptyFile(path.join(backupDir, 'config', `${project}.json`));
  return { present: db || contentStore || config, db, contentStore, config };
}
