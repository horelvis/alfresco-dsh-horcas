/**
 * Seccion de system prompt con la CONDUCTA operativa del agente: minimiza la narracion intermedia para
 * que el chat no se llene de comentarios entre llamadas a tools. El trabajo se entrega como un unico
 * resumen final con evidencia; se pregunta solo cuando falta un dato imprescindible.
 */
interface SystemPromptContext {
  systemPrompt: {
    section(section: { name: string; order: number; text: string | ((context: unknown) => string) }): unknown;
  };
}

export function conductSectionText(): string {
  return (
    'Conducta operativa: no narres pasos intermedios ni repitas el plan. Entre llamadas a herramientas ' +
    'no escribas texto. Ejecuta (o propone) el trabajo con las tools del migrador y, al terminar, entrega ' +
    'UN unico resumen final con la evidencia de las tools. Usa la via de preguntas del arnes ' +
    '(ask_user_question) solo si falta un dato imprescindible; no pidas confirmacion de lo ya aprobado. ' +
    'Evita relleno, disculpas y repeticiones.'
  );
}

export function installPrompt(ctx: SystemPromptContext): void {
  ctx.systemPrompt.section({
    name: 'alfresco-migrator-conduct',
    order: -999,
    text: () => conductSectionText(),
  });
}
