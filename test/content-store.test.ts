import { describe, expect, it } from 'vitest';
import { resolveContentStorePath, storePathFromMountpoint } from '../src/domain/content-store.js';

describe('resolucion del content store (path o volumen Docker)', () => {
  it('storePathFromMountpoint une mountpoint y subruta relativa', () => {
    expect(storePathFromMountpoint('/var/lib/docker/volumes/x/_data')).toBe('/var/lib/docker/volumes/x/_data');
    expect(storePathFromMountpoint('/var/lib/docker/volumes/x/_data/', 'contentstore')).toBe(
      '/var/lib/docker/volumes/x/_data/contentstore',
    );
    expect(storePathFromMountpoint('/mnt/v', '/contentstore')).toBe('/mnt/v/contentstore');
  });

  it('sin volumen devuelve la ruta tal cual; sin store, undefined', async () => {
    expect(await resolveContentStorePath({ type: 'FS', path: '/store' }, { name: 'local' })).toBe('/store');
    expect(await resolveContentStorePath(undefined, { name: 'local' })).toBeUndefined();
  });
});
