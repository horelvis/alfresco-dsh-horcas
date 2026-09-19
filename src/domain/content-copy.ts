/**
 * Plan de copia del content store (E8): traduce los tipos origen/destino (FS/S3/Azure) y la estrategia
 * a un comando ejecutable (rsync local/SSH, aws s3 sync, azcopy). El delta reutiliza la misma ruta.
 *
 * Portado de ContentCopyPlanner/ContentCopier.
 */

export type StoreType = 'FS' | 'S3' | 'AZURE';
export type TransferVia = 'RSYNC' | 'S3' | 'AZURE';

export interface ContentStoreRef {
  type: StoreType;
  path?: string;
  bucket?: string;
}

export interface ContentCopyPlan {
  via: TransferVia;
  delta: boolean;
  /** Comando shell unico a ejecutar en el host resuelto. */
  command: string;
}

const uri = (store: ContentStoreRef): string => {
  if (!store.bucket || !store.bucket.trim()) {
    throw new Error(`El content store ${store.type} requiere 'bucket' (o URL) en la configuracion`);
  }
  return store.type === 'S3' ? `s3://${store.bucket}` : store.bucket;
};

const requirePath = (store: ContentStoreRef, side: string): string => {
  if (!store.path) {
    throw new Error(`El content store FS requiere 'path' en ${side}`);
  }
  return store.path;
};

export interface CopyPlanOptions {
  /** Limite de ancho de banda para rsync (Kbps). */
  bandwidthKbps?: number;
  /** Copia incremental (delta) para el cutover. */
  delta?: boolean;
  /** Usar checksum en rsync (mas lento, mas fiable). */
  checksum?: boolean;
  /** Host SSH del origen/destino para rsync -e ssh. */
  sshTarget?: string;
}

/** Genera el plan de copia (un comando shell). */
export function planContentCopy(
  source: ContentStoreRef,
  target: ContentStoreRef,
  options: CopyPlanOptions = {},
): ContentCopyPlan {
  const delta = options.delta === true;

  if (source.type === 'FS' && target.type === 'FS') {
    const args = ['rsync', '-a', '--info=stats2'];
    if (delta) args.push('--delete');
    if (options.checksum) args.push('--checksum');
    if (options.bandwidthKbps && options.bandwidthKbps > 0) args.push(`--bwlimit=${options.bandwidthKbps}`);
    if (options.sshTarget) args.push('-e', `ssh -o BatchMode=yes`);
    args.push(`${requirePath(source, 'origen')}/`, options.sshTarget ? `${options.sshTarget}:${requirePath(target, 'destino')}/` : `${requirePath(target, 'destino')}/`);
    return { via: 'RSYNC', delta, command: args.map((a) => (a.includes(' ') ? `"${a}"` : a)).join(' ') };
  }

  if (source.type === 'FS' && target.type === 'S3') {
    return { via: 'S3', delta, command: `aws s3 sync "${requirePath(source, 'origen')}" ${uri(target)}${delta ? ' --delete' : ''}` };
  }
  if (source.type === 'S3' && target.type === 'S3') {
    return { via: 'S3', delta, command: `aws s3 sync ${uri(source)} ${uri(target)}${delta ? ' --delete' : ''}` };
  }
  if (source.type === 'S3' && target.type === 'FS') {
    return { via: 'S3', delta, command: `aws s3 sync ${uri(source)} "${requirePath(target, 'destino')}"${delta ? ' --delete' : ''}` };
  }
  if (source.type === 'AZURE' && target.type === 'FS') {
    return { via: 'AZURE', delta, command: `azcopy copy ${uri(source)} "${requirePath(target, 'destino')}" --recursive${delta ? ' --delete-destination=true' : ''}` };
  }
  if (source.type === 'FS' && target.type === 'AZURE') {
    return { via: 'AZURE', delta, command: `azcopy copy "${requirePath(source, 'origen')}" ${uri(target)} --recursive${delta ? ' --delete-destination=true' : ''}` };
  }
  if (source.type === 'AZURE' && target.type === 'AZURE') {
    return { via: 'AZURE', delta, command: `azcopy copy ${uri(source)} ${uri(target)} --recursive${delta ? ' --delete-destination=true' : ''}` };
  }
  throw new Error(`Combinacion de content store no soportada: ${source.type} -> ${target.type}`);
}
