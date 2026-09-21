import { describe, expect, it } from 'vitest';
import { helpText } from '../src/domain/help.js';

describe('ayuda de arranque', () => {
  it('incluye las frases de ejemplo y los recordatorios de seguridad', () => {
    const text = helpText();
    expect(text).toMatch(/iniciar migracion/);
    expect(text).toMatch(/continuar migracion/);
    expect(text).toMatch(/estado de la migracion/);
    expect(text).toMatch(/aprobacion/);
    expect(text).toMatch(/ORIGEN nunca se toca/);
  });
});
