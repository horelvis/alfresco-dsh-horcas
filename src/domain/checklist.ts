/**
 * Checklist pre/post-cutover, dependiente de version/edicion destino y motor de busqueda.
 * Portado de ChecklistService: Solr-off, Java 21/Tomcat 11, ActiveMQ 6.x o la Reindexing app
 * solo aplican segun la familia destino (y Solr-off solo en Enterprise).
 */
import { requiresSolrRemoval, breakingChangeGates } from './upgrade-paths.js';

export type ChecklistStatus = 'OK' | 'WARN' | 'FAIL' | 'PENDING';
export type ChecklistPhase = 'PRE' | 'POST';

export interface ChecklistSource {
  title: string;
  url: string;
}

export interface ChecklistItem {
  phase: ChecklistPhase;
  text: string;
  status: ChecklistStatus;
  detail: string;
  sources: ChecklistSource[];
}

export interface ChecklistInput {
  project: string;
  sourceVersion: string;
  targetVersion: string;
  sourceEdition: string;
  targetEdition: string;
  sourceSearch: string;
  targetSearch: string;
  hops: Array<{ from: string; to: string; pathClass: string }>;
}

const UPGRADE_PATHS: ChecklistSource = {
  title: 'Hyland Docs - Upgrade paths',
  url: 'https://docs.hyland.com/r/Alfresco/Alfresco-Content-Services/25.2/Alfresco-Content-Services/Upgrade/Upgrade-Content-Services/Upgrade-paths',
};
const DB_PATCH: ChecklistSource = {
  title: 'Hyland Docs - Apply optional performance database patch',
  url: 'https://docs.hyland.com/r/Alfresco/Alfresco-Content-Services/26.1/Alfresco-Content-Services/Upgrade/Upgrade-Content-Services/Apply-optional-performance-database-patch',
};
const REINDEX_APP: ChecklistSource = {
  title: 'Hyland Docs - Alfresco Re-indexing app',
  url: 'https://docs.hyland.com/r/Alfresco/Alfresco-Search-Enterprise/4.1/Alfresco-Search-Enterprise/Install/Install-using-JAR-files/Alfresco-Reindexing-app',
};
const SEARCH_SERVICES: ChecklistSource = {
  title: 'Hyland Docs - Alfresco Search Services',
  url: 'https://docs.hyland.com/r/Alfresco/Alfresco-Search-Services/2.0/Alfresco-Search-Services',
};

const item = (
  phase: ChecklistPhase,
  text: string,
  status: ChecklistStatus,
  detail: string,
  source: ChecklistSource,
): ChecklistItem => ({ phase, text, status, detail, sources: [source] });

export function buildChecklist(input: ChecklistInput): ChecklistItem[] {
  const items: ChecklistItem[] = [];

  items.push(item('PRE', 'Configuracion del proyecto valida', 'OK', `${input.project} -> ACS ${input.targetVersion}`, UPGRADE_PATHS));

  const validation = input.hops.some((h) => h.pathClass === 'REQUIRES_VALIDATION');
  const unsupported = input.hops.some((h) => h.pathClass === 'UNSUPPORTED');
  const path = input.hops.map((h) => `${h.from}->${h.to}[${h.pathClass}]`).join(' ; ') || '(directa)';
  items.push(
    item('PRE', 'Ruta de upgrade soportada', unsupported ? 'FAIL' : validation ? 'WARN' : 'OK', path, UPGRADE_PATHS),
  );

  if (input.sourceSearch.toUpperCase() === 'SOLR') {
    items.push(
      item('PRE', 'Search Services (Solr) actualizado antes del repositorio', 'PENDING', 'subir Search Services antes que el repositorio', SEARCH_SERVICES),
    );
  }
  if (requiresSolrRemoval(input.targetVersion, input.targetEdition)) {
    const ok = input.targetSearch.toUpperCase() !== 'SOLR';
    items.push(
      item('PRE', 'Solr desmantelado (Enterprise 26: Solr no soportado)', ok ? 'OK' : 'FAIL', `motor destino: ${input.targetSearch}`, REINDEX_APP),
    );
  }

  items.push(item('PRE', 'Backup de BD verificado/creado', 'PENDING', 'ejecutar migrator_run_steps (backup-source-db)', DB_PATCH));
  items.push(item('PRE', 'Backup del content store + manifest (SHA-256)', 'PENDING', 'ejecutar migrator_backup', UPGRADE_PATHS));
  items.push(
    item('PRE', 'Esquema PostgreSQL con PK/unicidad completos (6 tablas criticas)', 'PENDING', 'ejecutar migrator_schema_check', DB_PATCH),
  );
  items.push(item('PRE', 'Sin replicacion logica (CDC) activa en el origen', 'PENDING', 'ejecutar migrator_schema_check', UPGRADE_PATHS));
  items.push(item('PRE', 'Modulos/customizaciones revisados (Extension Inspector)', 'PENDING', `AMPs/JARs compatibles con ${input.targetVersion}`, UPGRADE_PATHS));
  items.push(item('PRE', 'Coherencia DB <-> content store sin referencias colgantes', 'PENDING', 'ejecutar migrator_coherence', UPGRADE_PATHS));
  items.push(item('PRE', gatesText(input), 'PENDING', 'gates de breaking changes', UPGRADE_PATHS));
  items.push(item('PRE', 'Estimacion de ventana de corte (benchmark)', 'PENDING', 'ejecutar migrator_estimate', DB_PATCH));
  items.push(item('PRE', 'Destino provisionado (o externo confirmado)', 'PENDING', 'ejecutar migrator_provision', UPGRADE_PATHS));

  items.push(item('POST', 'Coherencia tras la migracion (dangling=0)', 'PENDING', 'ejecutar migrator_coherence', UPGRADE_PATHS));
  const searchEnterprise = input.targetSearch.toUpperCase() !== 'SOLR';
  items.push(
    item(
      'POST',
      searchEnterprise
        ? 'Indice regenerado (Reindexing app; Total indexed documents)'
        : 'Indice regenerado (Solr tracking de los cores alfresco/archive)',
      'PENDING',
      'ejecutar migrator_run_steps (reindex)',
      searchEnterprise ? REINDEX_APP : SEARCH_SERVICES,
    ),
  );
  items.push(item('POST', 'Conteos de nodos/refs y content store verificados (ACL manual)', 'PENDING', 'ejecutar migrator_verify_target', UPGRADE_PATHS));
  items.push(item('POST', 'Origen retenido / rollback disponible (no destructivo)', 'OK', 'origen intacto hasta validar el destino', UPGRADE_PATHS));

  return items;
}

export function gatesText(input: ChecklistInput): string {
  const gates = breakingChangeGates(input.targetVersion, input.targetEdition);
  return `Gates de breaking changes para ${input.targetVersion}: ${gates.join('; ')}`;
}

const MARK: Record<ChecklistStatus, string> = { OK: 'x', WARN: '~', FAIL: '!', PENDING: ' ' };

export function renderChecklistMarkdown(project: string, items: ChecklistItem[]): string {
  const section = (phase: ChecklistPhase): string =>
    items
      .filter((i) => i.phase === phase)
      .map((i) => `- [${MARK[i.status]}] ${i.text} — **${i.status}** · ${i.detail} · [${i.sources[0]?.title}](${i.sources[0]?.url})`)
      .join('\n');
  return `# Checklist de comprobacion - ${project}\n## Pre-cutover\n${section('PRE')}\n## Post-cutover\n${section('POST')}\n`;
}
