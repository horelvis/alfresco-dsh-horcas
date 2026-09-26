import { describe, expect, it } from 'vitest';
import { MASK, envSecrets, installRedaction, parseEnvFile, redactText, type RedactContext } from '../src/security/redact.js';

const secret = 'f8c74128ca4f5594875a8990';

describe('redaccion de secretos en la salida de las tools', () => {
  it('enmascara el valor conocido aunque aparezca suelto', () => {
    expect(redactText(`la clave es ${secret} ok`, [secret])).toBe(`la clave es ${MASK} ok`);
  });

  it('enmascara por patron (properties, env, yaml, JAVA opts, URL)', () => {
    expect(redactText('db.password=S3cr3tValue9', [])).toBe(`db.password=${MASK}`);
    expect(redactText("docker exec -e PGPASSWORD='Xy12345678' c", [])).toBe(`docker exec -e PGPASSWORD='${MASK}' c`);
    expect(redactText('      POSTGRES_PASSWORD: abc123def456', [])).toBe(`      POSTGRES_PASSWORD: ${MASK}`);
    expect(redactText('-Dmetadata-keystore.password=mp6yc0UD9e -Dx=1', [])).toBe(`-Dmetadata-keystore.password=${MASK} -Dx=1`);
    expect(redactText('jdbc://alfresco:Pa55word99@db:5432/a', [])).toBe(`jdbc://alfresco:${MASK}@db:5432/a`);
  });

  it('no destroza valores triviales por defecto ni JSON', () => {
    expect(redactText('POSTGRES_PASSWORD: alfresco', [])).toBe('POSTGRES_PASSWORD: alfresco');
    expect(redactText('password=admin', ['admin'])).toBe('password=admin');
    const json = JSON.stringify({ password: 'Zz9876543210', ok: true });
    expect(JSON.parse(redactText(json, []))).toEqual({ password: MASK, ok: true });
  });

  it('lee secretos del stack.env y del entorno por nombre', () => {
    expect(parseEnvFile(`POSTGRES_PASSWORD=${secret}\nACTIVEMQ_ADMIN_LOGIN=admin\n`)).toEqual([secret]);
    expect(envSecrets({ OPENAI_API_KEY: 'sk-1', MIGRATOR_DST_USER: 'admin' })).toEqual(['sk-1']);
  });

  it('el listener post-execute redacta la salida de bash antes del LLM', async () => {
    const handlers: Record<string, (...args: never[]) => unknown> = {};
    const ctx = { on: (event: string, handler: (...args: never[]) => unknown) => { handlers[event] = handler; } } as unknown as RedactContext;
    process.env.MIGRATOR_TEST_PASSWORD = secret;
    try {
      installRedaction(ctx);
      const post = handlers['tools/post-execute'] as (e: unknown, r: unknown, n: () => Promise<unknown>) => Promise<{ content: Array<{ text: string }> }>;
      const out = await post({}, { content: [{ type: 'text', text: `cat props\ndb.password=${secret}` }] }, async () => ({ kind: 'accept' }));
      expect(out.content[0]!.text).toBe(`cat props\ndb.password=${MASK}`);
    } finally {
      delete process.env.MIGRATOR_TEST_PASSWORD;
    }
  });
});
