/**
 * Tools de LECCIONES compartidas: `migrator_lessons` (leer) y `migrator_lesson_add` (anotar).
 * Estado local global (fuera del workspace), para transmitir experiencia entre proyectos.
 */
import type { Context } from '@deepseek-ai/cordis';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { addLesson, loadLessons, renderLessons } from '../domain/lessons.js';
import { stateDir } from '../domain/experience.js';
import { syncAgentsMd } from '../domain/agents-md.js';
import { workspaceCwd } from '../infra/session.js';
import { loadProject } from '../domain/project-config.js';

const text = (value: string) => [{ type: 'text' as const, text: value }];
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = (value: unknown): any => JSON.parse(JSON.stringify(value));

export function registerLessonTools(ctx: Context): void {
  ctx.tools.register(
    defineTool({
      name: 'migrator_lessons',
      timeoutMs: 10_000,
      description:
        'Lecciones aprendidas COMPARTIDAS entre proyectos de migracion (memoria global): fallos que se repiten y su resolucion. Read-only; consultar antes de ejecutar y al planificar.',
      parameters: {},
      output: {
        schema: { type: 'array', items: { type: 'object', additionalProperties: true } },
        render: (_args, value) => {
          const lessons = value as Array<{ title: string; detail: string; tags?: string[] }>;
          return text(lessons.length ? renderLessons(lessons) : '(sin lecciones registradas)');
        },
      },
      async execute() {
        return json(await loadLessons());
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'migrator_lesson_add',
      timeoutMs: 10_000,
      description:
        'Anota una LECCION aprendida (memoria compartida entre proyectos): un fallo que se repite y su resolucion, con etiquetas. Usar cuando se descubra algo que ayude a futuras migraciones.',
      parameters: {
        title: { type: 'string', required: true, description: 'titulo corto de la leccion' },
        detail: { type: 'string', required: true, description: 'que pasa y como evitarlo/resolverlo' },
        tags: { type: 'array', items: { type: 'string' }, description: 'etiquetas (orden, restore, reindex, permisos, version...)' },
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => {
          const v = value as { title: string; at: string };
          return text(`leccion anotada [${v.at}]: ${v.title}`);
        },
      },
      async execute(args, exec) {
        let project: string | undefined;
        try {
          project = (await loadProject(undefined, workspaceCwd(exec))).project;
        } catch {
          project = undefined;
        }
        const lesson = await addLesson({
          title: args.title,
          detail: args.detail,
          ...(args.tags ? { tags: args.tags } : {}),
          ...(project ? { project } : {}),
        });
        // Refresca el bloque gestionado en ~/.dsh/AGENTS.md (memoria nativa del arnes): no rompe la tool.
        try {
          await syncAgentsMd(stateDir());
        } catch {
          // best-effort
        }
        return json(lesson);
      },
    }),
  );
}
