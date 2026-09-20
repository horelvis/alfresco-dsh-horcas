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
import { installLanguage } from './language.js';
import { installPrompt } from './prompt.js';
import { installSkills, type SkillsContext } from './skills.js';
import { registerReadTools } from './tools/read.js';
import { registerWriteTools } from './tools/write.js';
import { registerExperienceTools } from './tools/experience.js';
import { registerExecutionTools } from './tools/execution.js';
import { registerCoherenceTools } from './tools/coherence.js';
import { registerPlanningTools } from './tools/planning.js';
import { registerBackupTools } from './tools/backup.js';
import { registerAssessmentTools } from './tools/assessment.js';
import { registerReindexTools } from './tools/reindex.js';
import { registerProvisionTools } from './tools/provision.js';
import { registerContentCopyTools } from './tools/content-copy.js';
import { registerReviewerTools } from './tools/reviewer.js';
import { registerMountTools } from './tools/mounts.js';
import { registerWizardTools } from './tools/wizard.js';
import { registerGuardTools } from './tools/guards.js';
import { registerVerifyTools } from './tools/verify.js';

export const name = 'dsh-plugin-alfresco-migrator';
export const inject = ['tools', 'systemPrompt', 'skills'];

export function apply(ctx: Context): void {
  installSecurity(ctx as unknown as SecurityContext);
  installApproval(ctx as unknown as ApprovalContext);
  installLanguage(ctx as unknown as Parameters<typeof installLanguage>[0]);
  installPrompt(ctx as unknown as Parameters<typeof installPrompt>[0]);
  void installSkills(ctx as unknown as SkillsContext);
  registerReadTools(ctx);
  registerCoherenceTools(ctx);
  registerAssessmentTools(ctx);
  registerPlanningTools(ctx);
  registerBackupTools(ctx);
  registerReindexTools(ctx);
  registerProvisionTools(ctx);
  registerContentCopyTools(ctx);
  registerReviewerTools(ctx);
  registerMountTools(ctx);
  registerWizardTools(ctx);
  registerGuardTools(ctx);
  registerVerifyTools(ctx);
  registerExperienceTools(ctx);
  registerExecutionTools(ctx);
  registerWriteTools(ctx);
}
