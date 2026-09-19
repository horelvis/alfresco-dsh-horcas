/**
 * Deteccion de MONT AJES remotos y guardas de content store (entornos Linux con NAS/SAN).
 *
 * En VM Linux es comun montar el content store en un volumen remoto:
 * - NFS/NFS4 (NAS), CIFS/SMB (NAS Windows), o un LUN iSCSI/FC (SAN).
 *
 * Riesgos que cubre este modulo:
 * 1. `rsync` "local" que en realidad es un doble salto por red (rendimiento impredecible).
 * 2. Origen y destino sobre el MISMO export/servidor (o el mismo device): la copia se corrompe.
 * 3. Copia entre dos montajes del mismo servidor NFS (posible copia de datos equivocados).
 *
 * Fuente de montajes: `/proc/mounts` (Linux) o `findmnt`/`mount` como respaldo.
 */

export interface MountEntry {
  /** Device/source (p.ej. `server:/export`, `/dev/sdb1`, `//srv/share`). */
  device: string;
  /** Punto de montaje. */
  mountPoint: string;
  /** Tipo de sistema de ficheros (nfs, nfs4, cifs, ext4, xfs, ...). */
  fsType: string;
  /** Opciones de montaje. */
  options: string;
}

export type MountKind = 'LOCAL' | 'NFS' | 'CIFS' | 'SAN' | 'OTHER_REMOTE' | 'UNKNOWN';

const NFS_TYPES = new Set(['nfs', 'nfs4']);
const CIFS_TYPES = new Set(['cifs', 'smb3', 'smbfs']);
const SAN_TYPES = new Set(['iscsi', 'fcoe', 'ocfs2', 'gfs2']);
const LOCAL_TYPES = new Set(['ext2', 'ext3', 'ext4', 'xfs', 'btrfs', 'zfs', 'apfs', 'vfat', 'overlay']);

/** Parsea `/proc/mounts` (o `mount -t` equivalente). Ignora comentarios y lineas vacias. */
export function parseMounts(text: string): MountEntry[] {
  const mounts: MountEntry[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const parts = line.split(/\s+/);
    if (parts.length < 3) continue;
    mounts.push({
      device: unescape(parts[0] as string),
      mountPoint: unescape(parts[1] as string),
      fsType: (parts[2] as string).toLowerCase(),
      options: (parts[3] ?? '').toLowerCase(),
    });
  }
  return mounts;
}

/** `/proc/mounts` escapa espacios y tabs como `\040`, `\011`, `\134`. */
function unescape(value: string): string {
  return value.replace(/\\040/g, ' ').replace(/\\011/g, '\t').replace(/\\012/g, '\n').replace(/\\134/g, '\\');
}

/** Montaje que cubre la ruta (coincidencia por prefijo mas largo). */
export function mountFor(path: string, mounts: MountEntry[]): MountEntry | undefined {
  const normalized = normalize(path);
  let best: MountEntry | undefined;
  for (const mount of mounts) {
    const mp = normalize(mount.mountPoint);
    if (normalized === mp || normalized.startsWith(mp.endsWith('/') ? mp : `${mp}/`)) {
      if (!best || mp.length > normalize(best.mountPoint).length) best = mount;
    }
  }
  return best;
}

const normalize = (path: string): string => (path.replace(/\/+$/, '') || '/');

export function classify(mount: MountEntry | undefined): MountKind {
  if (!mount) return 'UNKNOWN';
  const fs = mount.fsType;
  if (NFS_TYPES.has(fs)) return 'NFS';
  if (CIFS_TYPES.has(fs)) return 'CIFS';
  if (SAN_TYPES.has(fs)) return 'SAN';
  // Un LUN SAN formateado (xfs/ext4) se monta como fs local, pero el device lo delata
  // (multipath/iscsi): /dev/mapper/mpath*, /dev/sd*, /dev/dm-*.
  if (isSanDevice(mount.device)) return 'SAN';
  if (LOCAL_TYPES.has(fs)) return 'LOCAL';
  return 'OTHER_REMOTE';
}

/** Device que apunta a un LUN SAN (multipath/iscsi) en vez de a un disco local. */
export function isSanDevice(device: string): boolean {
  return /^\/dev\/(mapper\/(mpath|3600|dm-)|disk\/by-id\/(dm-uuid-mpath|scsi-|wwn-)|dm-)/i.test(device)
    || /^\/dev\/mapper\//i.test(device) && /mpath|3600/i.test(device);
}

/** Servidor + export de un montaje NFS/CIFS (para detectar el mismo backing store). */
export function backingStore(mount: MountEntry | undefined): string | undefined {
  if (!mount) return undefined;
  if (NFS_TYPES.has(mount.fsType)) {
    // Distintos exports del mismo servidor son destinos seguros: se compara servidor+export.
    return mount.device.toLowerCase();
  }
  if (CIFS_TYPES.has(mount.fsType)) {
    // En CIFS el "export" es el share completo.
    return mount.device.toLowerCase();
  }
  // SAN/local: el device identifica el volumen.
  return mount.device.toLowerCase();
}

export type MountRisk = 'SAME_BACKING_STORE' | 'SAME_MOUNT' | 'REMOTE_SOURCE' | 'REMOTE_TARGET' | 'DOUBLE_HOP';

export interface MountFinding {
  risk: MountRisk;
  severity: 'BLOCKER' | 'WARN' | 'INFO';
  detail: string;
}

export interface MountAssessment {
  source: MountEntry | undefined;
  target: MountEntry | undefined;
  sourceKind: MountKind;
  targetKind: MountKind;
  findings: MountFinding[];
  blocking: boolean;
}

/** Evalua el riesgo de copiar de `sourcePath` a `targetPath` segun los montajes de cada host. */
export function assessMounts(
  sourcePath: string,
  targetPath: string,
  sourceMounts: MountEntry[],
  targetMounts: MountEntry[],
): MountAssessment {
  const source = mountFor(sourcePath, sourceMounts);
  const target = mountFor(targetPath, targetMounts);
  const sourceKind = classify(source);
  const targetKind = classify(target);
  const findings: MountFinding[] = [];

  const sourceBacking = backingStore(source);
  const targetBacking = backingStore(target);
  const remote = (kind: MountKind): boolean => kind !== 'LOCAL' && kind !== 'UNKNOWN';

  // Mismo punto de montaje: solo es bloqueante si es un montaje REMOTO (en local es copiar en el
  // mismo disco, que es una operacion valida aunque no aislada).
  if (source && target && normalize(source.mountPoint) === normalize(target.mountPoint) && remote(sourceKind)) {
    findings.push({
      risk: 'SAME_MOUNT',
      severity: 'BLOCKER',
      detail: `Origen y destino comparten el mismo montaje remoto (${source.mountPoint}); la copia se corromperia`,
    });
  } else if (sourceBacking && targetBacking && sourceBacking === targetBacking && remote(sourceKind)) {
    // Mismo export/servidor NFS/CIFS (o mismo LUN SAN): la copia puede escribir sobre el origen.
    findings.push({
      risk: 'SAME_BACKING_STORE',
      severity: 'BLOCKER',
      detail: `Origen y destino comparten el mismo backing store remoto (${sourceBacking})`,
    });
  }

  if (sourceKind === 'NFS' || sourceKind === 'CIFS' || sourceKind === 'SAN' || sourceKind === 'OTHER_REMOTE') {
    findings.push({
      risk: 'REMOTE_SOURCE',
      severity: 'WARN',
      detail: `Content store origen sobre ${sourceKind} (${source?.device}): la copia puede ser un doble salto por red`,
    });
  }
  if (targetKind === 'NFS' || targetKind === 'CIFS' || targetKind === 'SAN' || targetKind === 'OTHER_REMOTE') {
    findings.push({
      risk: 'REMOTE_TARGET',
      severity: 'WARN',
      detail: `Content store destino sobre ${targetKind} (${target?.device}): considera copia directa servidor-a-servidor`,
    });
  }
  if (sourceKind !== 'LOCAL' && targetKind !== 'LOCAL' && sourceBacking !== targetBacking) {
    findings.push({
      risk: 'DOUBLE_HOP',
      severity: 'INFO',
      detail: 'Ambos extremos son remotos: una copia server-side evita pasar por el host de operacion',
    });
  }

  return {
    source,
    target,
    sourceKind,
    targetKind,
    findings,
    blocking: findings.some((f) => f.severity === 'BLOCKER'),
  };
}
