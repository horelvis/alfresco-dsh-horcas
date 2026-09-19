import { describe, expect, it } from 'vitest';
import {
  assessMounts,
  backingStore,
  classify,
  classifyDevice,
  deviceForMount,
  mountFor,
  parseLsblk,
  parseMounts,
} from '../src/domain/mounts.js';

// Caso real de cliente (Ubuntu VM): el content store vive en /repositorio (/dev/sdb1).
const CLIENT_MOUNTS = parseMounts(`
tmpfs /run tmpfs rw 0 0
/dev/mapper/ubuntu--vg-ubuntu--lv / ext4 rw 0 0
tmpfs /dev/shm tmpfs rw 0 0
tmpfs /run/lock tmpfs rw 0 0
/dev/sda2 /boot ext4 rw 0 0
/dev/sdb1 /repositorio ext4 rw 0 0
tmpfs /run/user/1000 tmpfs rw 0 0
`);

const MOUNTS = parseMounts(`
/dev/sda1 / ext4 rw,relatime 0 0
server1:/export/alf /mnt/alf nfs4 rw,vers=4.2 0 0
//nas.acme.local/share /mnt/nas cifs rw,vers=3.0 0 0
/dev/mapper/mpatha /mnt/san xfs rw 0 0
tmpfs /tmp tmpfs rw 0 0
`);

describe('parseMounts', () => {
  it('parsea tipo y device', () => {
    const nfs = MOUNTS.find((m) => m.fsType === 'nfs4');
    expect(nfs?.device).toBe('server1:/export/alf');
    expect(nfs?.mountPoint).toBe('/mnt/alf');
  });
});

describe('mountFor / classify', () => {
  it('encuentra el montaje por prefijo mas largo', () => {
    expect(mountFor('/mnt/alf/2025/9/x.bin', MOUNTS)?.mountPoint).toBe('/mnt/alf');
    expect(classify(mountFor('/mnt/alf/x', MOUNTS))).toBe('NFS');
    expect(classify(mountFor('/mnt/nas/x', MOUNTS))).toBe('CIFS');
    expect(classify(mountFor('/mnt/san/x', MOUNTS))).toBe('SAN');
    expect(classify(mountFor('/etc/hosts', MOUNTS))).toBe('LOCAL');
  });
});

describe('assessMounts (NAS/SAN)', () => {
  it('mismo export NFS origen/destino -> BLOCKER', () => {
    const result = assessMounts('/mnt/alf/src', '/mnt/alf/dst', MOUNTS, MOUNTS);
    expect(result.blocking).toBe(true);
    expect(result.findings.some((f) => f.risk === 'SAME_BACKING_STORE' || f.risk === 'SAME_MOUNT')).toBe(true);
  });

  it('mismo servidor NFS con exports distintos -> seguro (no bloquea)', () => {
    const other = parseMounts('server1:/export/otro /mnt/otro nfs4 rw 0 0');
    const result = assessMounts('/mnt/alf/src', '/mnt/otro/dst', MOUNTS, other);
    expect(result.findings.some((f) => f.severity === 'BLOCKER')).toBe(false);
  });

  it('NFS -> local: WARN por origen remoto, no bloqueante', () => {
    const result = assessMounts('/mnt/alf/src', '/opt/dst', MOUNTS, MOUNTS);
    expect(result.blocking).toBe(false);
    expect(result.findings.some((f) => f.risk === 'REMOTE_SOURCE' && f.severity === 'WARN')).toBe(true);
  });

  it('local -> local en el mismo disco: sin hallazgos (copiar en el mismo disco es valido)', () => {
    expect(assessMounts('/opt/src', '/opt/dst', MOUNTS, MOUNTS).findings).toHaveLength(0);
  });

  it('dos extremos remotos distintos -> INFO de doble salto', () => {
    const result = assessMounts('/mnt/alf/src', '/mnt/nas/dst', MOUNTS, MOUNTS);
    expect(result.findings.some((f) => f.risk === 'DOUBLE_HOP')).toBe(true);
  });

  it('backingStore identifica servidor+export (NFS) y share (CIFS)', () => {
    expect(backingStore(MOUNTS.find((m) => m.fsType === 'nfs4'))).toBe('server1:/export/alf');
    expect(backingStore(MOUNTS.find((m) => m.fsType === 'cifs'))).toBe('//nas.acme.local/share');
  });
});

describe('lsblk / device (VM y SAN)', () => {
  it('detecta LUN iSCSI aunque el fs sea ext4 (parece local)', () => {
    const devices = parseLsblk(`
sda     sata   ATA      Samsung_SSD
sdb     iscsi  NETAPP   LUN_C
nvme0n1 nvme   Samsung  980
`);
    const sdb = devices.find((d) => d.name === 'sdb');
    expect(classifyDevice(sdb)).toBe('SAN');
    expect(classify(mountFor('/repositorio/x', parseMounts('/dev/sdb1 /repositorio ext4 rw 0 0')), sdb)).toBe('SAN');
  });

  it('disco virtual del hipervisor se marca VIRTUAL', () => {
    const devices = parseLsblk('sda virtio - -\nsdb vmw VMware Virtual disk');
    expect(classifyDevice(devices.find((d) => d.name === 'sda'))).toBe('VIRTUAL');
    expect(classifyDevice(devices.find((d) => d.name === 'sdb'))).toBe('VIRTUAL');
  });

  it('caso cliente: /repositorio en /dev/sdb1 local sin lsblk -> LOCAL', () => {
    const mount = mountFor('/repositorio/contentstore', CLIENT_MOUNTS);
    expect(classify(mount)).toBe('LOCAL');
    expect(classifyDevice(deviceForMount(mount, parseLsblk('sda sata ATA SSD\nsdb sata ATA WDC_WD10')))).toBe('LOCAL_DISK');
  });

  it('aviso de VM: dos discos virtuales del mismo hipervisor', () => {
    const devices = parseLsblk('sda vmw VMware Virtual disk\nsdb vmw VMware Virtual disk');
    const mounts = parseMounts('/dev/sda1 /opt/src ext4 rw 0 0\n/dev/sdb1 /opt/dst ext4 rw 0 0');
    const result = assessMounts('/opt/src', '/opt/dst', mounts, mounts, devices, devices);
    expect(result.findings.some((f) => f.severity === 'WARN' && f.detail.includes('datastore'))).toBe(true);
  });
});
