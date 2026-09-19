/**
 * Seccion de system prompt que fija el IDIOMA por defecto del agente.
 *
 * El agente del migrador trabaja para un equipo hispanohablante: por defecto responde en espanol.
 * Configurable con `MIGRATOR_LANG` (p.ej. `es` (defecto), `en`, `pt`). El prompt se registra en el
 * `ctx.systemPrompt` del arnes.
 */

const NAMES: Record<string, string> = {
  es: 'espanol',
  en: 'English',
  pt: 'portugues',
  fr: 'francais',
  de: 'Deutsch',
};

export function defaultLanguage(env: NodeJS.ProcessEnv = process.env): string {
  return (env.MIGRATOR_LANG ?? 'es').trim().toLowerCase() || 'es';
}

export function languageSectionText(env: NodeJS.ProcessEnv = process.env): string {
  const language = defaultLanguage(env);
  const name = NAMES[language] ?? language;
  return (
    `Responde SIEMPRE en ${name}, salvo que el usuario pida explicitamente otro idioma. ` +
    'Manten en su forma original los identificadores tecnicos (nombres de tools, rutas, versiones, ' +
    'codigos de hallazgo y claves de configuracion).'
  );
}

interface SystemPromptContext {
  systemPrompt: {
    section(section: { name: string; order: number; text: string | ((context: unknown) => string) }): unknown;
  };
}

export function installLanguage(ctx: SystemPromptContext, env: NodeJS.ProcessEnv = process.env): void {
  ctx.systemPrompt.section({
    name: 'alfresco-migrator-language',
    order: -1000,
    text: () => languageSectionText(env),
  });
}
