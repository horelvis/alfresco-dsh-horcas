import { describe, expect, it } from 'vitest';
import { HelpCommand } from '../src/commands.js';
import { helpText } from '../src/domain/help.js';

describe('comando /help (sin pasar por el modelo)', () => {
  it('solo se monta con el servicio commands y registra /help con la ayuda de arranque', async () => {
    expect(HelpCommand.inject).toEqual(['commands']);
    const registered: Array<{ name: string; handler: (i: { rawInput: string }) => unknown }> = [];
    const ctx = {
      effect: (fn: () => unknown) => fn(),
      commands: { register: (def: (typeof registered)[number]) => (registered.push(def), () => undefined) },
    };
    HelpCommand.apply(ctx as never);
    expect(registered.map((d) => d.name)).toEqual(['help']);
    expect(await registered[0]!.handler({ rawInput: '' })).toEqual({ kind: 'success', text: helpText() });
  });
});
