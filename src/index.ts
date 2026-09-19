/**
 * dsh plugin: agente de migracion de Alfresco Content Services.
 *
 * Arquitectura: el arnes `dsh` aporta el loop, la memoria de sesion y las herramientas; este plugin
 * aporta el dominio (rutas de version, esquemas de referencia, recomendaciones oficiales) y ENCAPSULA
 * la seguridad (origen inmutable; escritura solo en destino y con aprobacion).
 */
import type { Context } from '@deepseek-ai/cordis';
import { installSecurity, type SecurityContext } from './security/policy.js';
import { installApproval, type ApprovalContext } from './approval.js';
import { registerReadTools } from './tools/read.js';
import { registerWriteTools } from './tools/write.js';
import { registerExperienceTools } from './tools/experience.js';
import { registerExecutionTools } from './tools/execution.js';
import { registerCoherenceTools } from './tools/coherence.js';

export const name = 'dsh-plugin-alfresco-migrator';
export const inject = ['tools'];

export function apply(ctx: Context): void {
  installSecurity(ctx as unknown as SecurityContext);
  installApproval(ctx as unknown as ApprovalContext);
  registerReadTools(ctx);
  registerCoherenceTools(ctx);
  registerExperienceTools(ctx);
  registerExecutionTools(ctx);
  registerWriteTools(ctx);
}
