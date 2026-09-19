/**
 * Conocimiento del dominio como SKILLS del arnes (on-demand, no en el system prompt).
 *
 * El agente carga estas skills cuando las necesita; el catalogo solo lleva nombre + descripcion.
 * El contenido viene de `data/recommendations.yaml` (respaldado por documentacion oficial) y de la
 * matriz de gates/rutas, de modo que el conocimiento evoluciona sin tocar codigo.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import yaml from 'js-yaml';
import { dataDir } from './domain/data-dir.js';
import { breakingChangeGates, requiresSolrRemoval } from './domain/versions.js';

export interface SkillContent {
  name: string;
  description: string;
  content: string;
}

interface Recommendation {
  code: string;
  title: string;
  actions: string[];
  sources: Array<{ title: string; url: string }>;
}

export async function loadRecommendationSkill(): Promise<SkillContent> {
  const parsed = yaml.load(await readFile(path.join(dataDir(), 'recommendations.yaml'), 'utf8')) as {
    recommendations?: Recommendation[];
  };
  const recommendations = parsed.recommendations ?? [];
  const body = recommendations
    .map((r) => {
      const actions = r.actions.map((a) => `- ${a}`).join('\n');
      const sources = r.sources.map((s) => `- [${s.title}](${s.url})`).join('\n');
      return `## ${r.title} (\`${r.code}\`)\n${actions}\n\nFuentes oficiales:\n${sources}`;
    })
    .join('\n\n');
  return {
    name: 'alfresco-migration-recommendations',
    description:
      'Acciones respaldadas por documentacion oficial de Hyland/Alfresco para cada codigo de hallazgo del migrador (COHERENCE_DANGLING, SCHEMA_INTEGRITY, CDC_REPLICA_IDENTITY, LOW_CONFIDENCE, etc.). Cargar al decidir como resolver un hallazgo.',
    content: `# Recomendaciones oficiales de migracion Alfresco\n\n${body}\n`,
  };
}

export function upgradeGatesSkill(): SkillContent {
  const lines: string[] = [];
  for (const version of ['7.4', '23.4', '25.3', '26.1', '26.2']) {
    for (const edition of ['CE', 'EE']) {
      const gates = breakingChangeGates(version, edition).join('; ');
      lines.push(`- **${version} ${edition}**: ${gates}${requiresSolrRemoval(version, edition) ? ' · Solr debe desmantelarse' : ''}`);
    }
  }
  return {
    name: 'alfresco-upgrade-gates',
    description:
      'Matriz de gates de breaking changes por version/edicion destino (Java 21/Tomcat 11, ActiveMQ 6.x con autenticacion, eventos v2, Solr-off en Enterprise desde 26) y rutas de upgrade soportadas. Cargar al planificar un salto de version.',
    content: `# Gates de breaking changes y rutas de upgrade\n\n${lines.join('\n')}\n\nRutas soportadas: 7.x < 7.2 requiere validacion del fabricante; 7.4 -> 25.3 -> 26.2. Subir Search Services (Solr) antes que el repositorio.\n`,
  };
}

export function migrationPlaybookSkill(): SkillContent {
  return {
    name: 'alfresco-migration-playbook',
    description:
      'Flujo operativo de una migracion ACS a 26.x: assessment, ensayo en clone/TEST, drift a PROD, backup no destructivo, pasos de ejecucion (preflight, dump, copia, restore, schema-upgrade, reindex, verify), coherencia y forense de colangantes, gates GO/NO-GO. Cargar al ejecutar o supervisar una migracion.',
    content: `# Playbook de migracion ACS -> 26.x

1. **Assessment** (\`migrator_assess\`): inventario desde la fuente de verdad (REST + JDBC + store). Nunca usar indices de busqueda.
2. **Planificacion**: \`migrator_upgrade_path\`, \`migrator_strategy\`, \`migrator_estimate\`, \`migrator_checklist\`.
3. **Preflight**: \`migrator_schema_check\` (PK/UNIQUE + CDC), \`migrator_coherence\`.
4. **Ensayo en clone/TEST**: \`migrator_run_steps\` + \`migrator_rehearsal_record\`. Si falla, restaurar y reanudar (\`resume=true\`).
5. **Paridad a PROD**: \`migrator_environment_parity\`; sin ensayo validado o con drift BLOCKER, PROD se bloquea.
6. **Backup no destructivo**: \`migrator_backup\` (BD + store + manifiesto SHA-256). El origen nunca se modifica.
7. **Ejecucion en destino**: preflight-target -> backup-source-db -> copy-content -> restore-target-db -> schema-upgrade -> reindex -> verify-target.
8. **Post**: coherencia con dangling=0, reindex verificado, conteos/checksums/ACL, origen retenido para rollback.

Reglas duras: el ORIGEN es inmutable; las escrituras van solo al DESTINO y con aprobacion; los indices de busqueda se regeneran, nunca se migran; no ejecutar CDC sin REPLICA IDENTITY.
`,
  };
}

export async function allSkills(): Promise<SkillContent[]> {
  return [await loadRecommendationSkill(), upgradeGatesSkill(), migrationPlaybookSkill()];
}

export interface SkillsContext {
  skills: {
    register(skill: { name: string; description: string; content: string; source: string }): unknown;
  };
}

/** Registra el conocimiento del dominio como skills del arnes (efectos reversibles: se liberan al descargar el plugin). */
export function installSkills(ctx: SkillsContext): void {
  const register = (skill: SkillContent) => ctx.skills.register({ ...skill, source: 'runtime' });
  register(upgradeGatesSkill());
  register(migrationPlaybookSkill());
  // La skill de recomendaciones se carga desde disco (async): se registra cuando este lista.
  void loadRecommendationSkill().then(register).catch(() => undefined);
}
