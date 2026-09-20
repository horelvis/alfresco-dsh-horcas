import { describe, expect, it } from 'vitest';
import { conductSectionText } from '../src/prompt.js';

describe('conducta operativa (system prompt)', () => {
  it('pide no narrar pasos intermedios y entregar un unico resumen final', () => {
    const text = conductSectionText();
    expect(text).toMatch(/no narres pasos intermedios/i);
    expect(text).toMatch(/unico resumen final/i);
    expect(text).toMatch(/ask_user_question/);
  });
});
