import { describe, expect, it } from 'vitest';
import { describeError } from '../src/infra/errors.js';

describe('describeError', () => {
  it('aplana AggregateError (message vacio) con el detalle interno', () => {
    const inner = Object.assign(new Error(''), { code: 'ECONNREFUSED' });
    const agg = new AggregateError([inner], '');
    expect(agg.message).toBe('');
    expect(describeError(agg)).toContain('ECONNREFUSED');
  });

  it('usa code si el mensaje viene vacio', () => {
    const err = Object.assign(new Error(''), { code: 'ETIMEDOUT' });
    expect(describeError(err)).toBe('ETIMEDOUT');
  });

  it('devuelve el mensaje normal y cadenas/objetos sueltos', () => {
    expect(describeError(new Error('boom'))).toBe('boom');
    expect(describeError('texto')).toBe('texto');
    expect(describeError({ code: 'EPERM' })).toBe('EPERM');
  });
});
