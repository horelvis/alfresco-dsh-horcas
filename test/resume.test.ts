import { describe, expect, it } from 'vitest';
import { nextAction, sessionsDirFor } from '../src/domain/resume.js';

const base = { hasProject: true, hops: 3, backupComplete: true };

describe('nextAction', () => {
  it('sin proyecto pide crearlo', () => {
    expect(nextAction({ hasProject: false, hops: 0, backupComplete: false })).toMatch(/migrator_wizard/);
  });

  it('con punto de reanudacion manda reanudar', () => {
    expect(nextAction({ ...base, resumeFrom: 'schema-upgrade' })).toMatch(/Reanuda el run desde 'schema-upgrade'/);
  });

  it('destino en version equivocada pide provisionar el hop', () => {
    expect(nextAction({ ...base, hopPending: '7.4', hopOk: false, destinationVersion: '26.2.0' })).toMatch(/provisiona/);
  });

  it('destino no verificable avisa de la URL', () => {
    expect(nextAction({ ...base, hopPending: '7.4', hopOk: false })).toMatch(/MIGRATOR_DST_BASE_URL/);
  });

  it('backup incompleto pide backup', () => {
    expect(nextAction({ ...base, hopPending: '7.4', hopOk: true, destinationVersion: '7.4.0', backupComplete: false })).toMatch(/migrator_backup/);
  });

  it('estado listo propone dry-run y ejecucion', () => {
    expect(nextAction({ ...base, hopPending: '7.4', hopOk: true, destinationVersion: '7.4.0' })).toMatch(/dry-run/);
  });
});

describe('sessionsDirFor', () => {
  it('codifica espacios y barras como dsh', () => {
    const dir = sessionsDirFor('/Volumes/Mac SSD/u/acme-migration', '/home/u');
    expect(dir).toBe('/home/u/.dsh/sessions/--Volumes-Mac~0020SSD-u-acme-migration--');
  });
});
