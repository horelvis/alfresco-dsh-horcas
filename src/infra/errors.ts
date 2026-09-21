/**
 * Normaliza cualquier error a un texto util. `AggregateError` (lo lanza `Promise.all` con varios
 * rechazos y tambien `net.connect` al fallar todas las direcciones de un host) trae `message` VACIO,
 * de modo que el arnes lo mostraba como `Error:` sin detalle; aqui se aplanan sus errores internos.
 */
export function describeError(error: unknown): string {
  if (error instanceof AggregateError) {
    const inner = error.errors.map(describeError).filter(Boolean);
    return inner.length > 0 ? inner.join(' | ') : 'AggregateError (sin detalle)';
  }
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code;
    const message = error.message?.trim();
    return message || code || error.name || 'Error';
  }
  if (typeof error === 'string') return error.trim() || 'Error';
  if (error && typeof error === 'object') {
    const loose = error as { message?: unknown; code?: unknown };
    if (typeof loose.message === 'string' && loose.message.trim()) return loose.message;
    if (typeof loose.code === 'string' && loose.code.trim()) return loose.code;
  }
  return String(error);
}
