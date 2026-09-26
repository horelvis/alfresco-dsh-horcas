/**
 * Tool de inventario del STACK del ORIGEN (solo lectura): servicios por rol y customizaciones
 * (AMPs/JARs/config) que las imagenes estandar del destino no traen. Detecta y AVISA (evidencia
 * `modules`); no instala nada.
 */
import type { Context } from '@deepseek-ai/cordis';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { workspaceCwd } from '../infra/session.js';
import { loadProject } from '../domain/project-config.js';
import { scanSourceStack, summarizeStack } from '../domain/source-stack.js';
import { recordEvidence } from '../domain/evidence.js';
import { stateDir } from '../domain/experience.js';

const text = (value: string) => [{ type: 'text' as const, text: value }];
const json = <T>(value: T): never => JSON.parse(JSON.stringify(value)) as never;

export function registerSourceStackTools(ctx: Context): void {
  ctx.tools.register(
    defineTool({
      name: 'migrator_source_stack',
      timeoutMs: 60_000,
      description:
        'Inventaria el despliegue del ORIGEN (source.deployDir: docker-compose + Dockerfiles), solo lectura: servicios por rol (repositorio, Share, transform, busqueda, LDAP, proxy...) y CUSTOMIZACIONES (AMPs/JARs/config) que las imagenes estandar del destino no traen. Registra la evidencia del item "Modulos/customizaciones" (WARN si hay customizaciones: decision humana). Usalo en la planificacion para preguntar al humano el stack final.',
      parameters: {},
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => {
          const v = value as { summary: string; status: string; warnings: string[] };
          return text(`${v.status}: ${v.summary}${v.warnings.length ? `\navisos: ${v.warnings.join('; ')}` : ''}`);
        },
      },
      async execute(_args, exec) {
        const project = await loadProject(undefined, workspaceCwd(exec));
        const dir = project.source.deployDir;
        if (!dir) {
          return json({ status: 'PENDING', summary: 'sin source.deployDir en el YAML: no se puede inventariar el stack del origen', warnings: [], services: [], customizations: [] });
        }
        const stack = await scanSourceStack(dir);
        const summary = summarizeStack(stack);
        // Hay customizaciones => WARN (el destino estandar no las trae; decide el humano). Ninguna => OK.
        const status = stack.services.length === 0 ? 'PENDING' : stack.customizations.length > 0 ? 'WARN' : 'OK';
        if (status !== 'PENDING') await recordEvidence(stateDir(), project.project, 'modules', status, summary);
        return json({ status, summary, ...stack });
      },
    }),
  );

}
