/**
 * Secciones de system prompt del plugin:
 * - CONDUCTA operativa: minimiza narracion y define las entradas minimas.
 * - CONTEXTO del proyecto: deja EXPLICITO el `stage` (ENSAYO vs PROD) y la ruta, leyendo el YAML del
 *   workspace de forma sincrona (la seccion de prompt se evalua en cada ensamblado).
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { lessonsTextSync } from './domain/lessons.js';

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
    'Evita relleno, disculpas y repeticiones. ' +
    'Entradas minimas: si el usuario dice solo "iniciar migracion" o "continuar migracion" (o equivalente), ' +
    'carga la skill `alfresco-migration-playbook` y sigue su runbook; no le pidas un prompt detallado. ' +
    'Al INICIAR un chat (primer mensaje del usuario: saludo, "ayuda" o vacio) muestra la ayuda de arranque ' +
    'con `migrator_help` (frases de ejemplo) y espera; no hagas trabajo hasta que el usuario elija.'
  );
}

/** Lee el proyecto del workspace (sincrono) y describe el ENTORNO: stage (ENSAYO/PROD) y ruta. */
export function projectContextText(cwd: string = process.cwd(), env: NodeJS.ProcessEnv = process.env): string {
  try {
    const candidates: string[] = [];
    if (env.MIGRATOR_PROJECT) candidates.push(path.resolve(cwd, env.MIGRATOR_PROJECT));
    try {
      for (const file of readdirSync(cwd)) {
        if (file.endsWith('.yaml') || file.endsWith('.yml')) candidates.push(path.join(cwd, file));
      }
    } catch {
      // sin acceso al cwd: se prueba solo MIGRATOR_PROJECT
    }
    for (const file of candidates) {
      try {
        const doc = yaml.load(readFileSync(file, 'utf8')) as
          | { project?: unknown; stage?: unknown; source?: { version?: unknown }; target?: { version?: unknown } }
          | undefined;
        if (!doc || typeof doc !== 'object' || !doc.source || !doc.target) continue;
        const stage = String(doc.stage ?? 'test').toLowerCase();
        const isProd = stage === 'prod';
        return (
          `Entorno de migracion: proyecto "${String(doc.project ?? '?')}", stage=${stage} ` +
          `(${isProd ? 'PRODUCCION: exige ensayo validado' : 'ENSAYO: NO es PROD; NO apliques los gates de PROD (ensayo validado/drift)'}), ` +
          `ruta ${String(doc.source.version ?? '?')} -> ${String(doc.target.version ?? '?')}.`
        );
      } catch {
        // fichero no parseable: se prueba el siguiente
      }
    }
  } catch {
    // sin proyecto: no se aporta contexto
  }
  return '';
}

export function installPrompt(ctx: SystemPromptContext): void {
  ctx.systemPrompt.section({
    name: 'alfresco-migrator-conduct',
    order: -999,
    text: () => conductSectionText(),
  });
  ctx.systemPrompt.section({
    name: 'alfresco-migrator-context',
    order: -998,
    text: () => projectContextText(),
  });
  // Lecciones compartidas entre proyectos: memoria global (fuera del workspace).
  ctx.systemPrompt.section({
    name: 'alfresco-migrator-lessons',
    order: -997,
    text: () => {
      const lessons = lessonsTextSync();
      return lessons ? `Lecciones aprendidas (memoria compartida entre proyectos):\n${lessons}` : '';
    },
  });
}
