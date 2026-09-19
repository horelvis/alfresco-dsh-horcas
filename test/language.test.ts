import { describe, expect, it } from 'vitest';
import { defaultLanguage, languageSectionText } from '../src/language.js';

describe('idioma por defecto', () => {
  it('por defecto es español', () => {
    expect(defaultLanguage({})).toBe('es');
    expect(languageSectionText({})).toContain('espanol');
  });

  it('respeta MIGRATOR_LANG', () => {
    expect(languageSectionText({ MIGRATOR_LANG: 'en' })).toContain('English');
    expect(languageSectionText({ MIGRATOR_LANG: 'pt' })).toContain('portugues');
  });

  it('mantiene identificadores tecnicos', () => {
    expect(languageSectionText({})).toContain('identificadores tecnicos');
  });
});
