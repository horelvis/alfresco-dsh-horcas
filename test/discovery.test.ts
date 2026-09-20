import { afterEach, describe, expect, it, vi } from 'vitest';
import { discoverRest } from '../src/domain/assessment.js';

const reply = (body: unknown, ok = true, status = 200) => ({ ok, status, json: async () => body });

afterEach(() => vi.unstubAllGlobals());

describe('discoverRest (fallback de endpoints)', () => {
  it('cae al web script /api/discovery si la API v1 responde 404 (version como cadena)', async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        calls.push(String(url));
        if (String(url).includes('/versions/1/discovery')) return reply({ error: {} }, false, 404);
        return reply({ entry: { repository: { version: { major: '26', minor: '2', patch: '0' }, edition: 'Community' } } });
      }),
    );
    const found = await discoverRest('http://host:8080/alfresco', 'admin', 'admin');
    expect(found).toEqual({ version: '26.2.0', edition: 'CE' });
    expect(calls[0]).toContain('/alfresco/api/-default-/public/alfresco/versions/1/discovery');
    expect(calls[1]).toBe('http://host:8080/alfresco/api/discovery');
  });

  it('no duplica /api cuando la base ya lo incluye y detecta edicion Enterprise', async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        calls.push(String(url));
        return reply({ entry: { repository: { version: { major: 7, minor: 4, patch: 0 }, edition: 'Enterprise' } } });
      }),
    );
    const found = await discoverRest('http://host:8080/alfresco/api/');
    expect(found).toEqual({ version: '7.4.0', edition: 'EE' });
    expect(calls[0]).toBe('http://host:8080/alfresco/api/-default-/public/alfresco/versions/1/discovery');
  });

  it('sin endpoint disponible -> undefined (fail-closed)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => reply({}, false, 500)));
    expect(await discoverRest('http://host:8080/alfresco')).toBeUndefined();
  });
});
