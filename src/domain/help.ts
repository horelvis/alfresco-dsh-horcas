/**
 * Ayuda de arranque para alguien SIN experiencia: que basta escribir una frase. Se muestra al iniciar el
 * chat (primer mensaje) o cuando el usuario pide ayuda. Texto estable (no lo inventa el modelo).
 */
export function helpText(): string {
  return [
    '**Migracion Alfresco** — escribe una frase y el agente hace el resto:',
    '',
    '- `iniciar migracion` — evalua (solo lectura), propone plan y dry-run del hop que toca.',
    '- `continuar migracion` — retoma donde lo dejaste (estado + contexto de chats previos).',
    '- `estado de la migracion` — resumen: hop actual, backup, destino y siguiente accion.',
    '- `verifica el destino` — version y salud del destino (p. ej. 26.2).',
    '- `analiza el origen` — coherencia, esquema y estimacion (solo lectura).',
    '',
    'Recuerda:',
    '- **Nada se escribe sin tu aprobacion** (sandbox `read-only` + confirmacion en dos pasos).',
    '- El **ORIGEN nunca se toca**: se trabaja desde el backup.',
    '- Ruta obligatoria por hops: **7.1.0 → 7.4 → 25.3 → 26.2** (no se puede saltar ninguna version de la ruta).',
  ].join('\n');
}
