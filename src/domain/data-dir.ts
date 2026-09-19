/** Directorio de datos de dominio (esquemas, recomendaciones, proyectos). */
import path from 'node:path';

export function dataDir(): string {
  return process.env.MIGRATOR_DATA_DIR ?? path.resolve(process.cwd(), 'data');
}
