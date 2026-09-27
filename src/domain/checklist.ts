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
  /** Clave estable para resolver el estado con evidencia (ver `applyEvidence`). */
  key: string;
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
  key: string,
  phase: ChecklistPhase,
  text: string,
  status: ChecklistStatus,
  detail: string,
  source: ChecklistSource,
): ChecklistItem => ({ key, phase, text, status, detail, sources: [source] });

export function buildChecklist(input: ChecklistInput): ChecklistItem[] {
  const items: ChecklistItem[] = [];

  items.push(item('config', 'PRE', 'Configuracion del proyecto valida', 'OK', `${input.project} -> ACS ${input.targetVersion}`, UPGRADE_PATHS));

  const validation = input.hops.some((h) => h.pathClass === 'REQUIRES_VALIDATION');
  const unsupported = input.hops.some((h) => h.pathClass === 'UNSUPPORTED');
  const path = input.hops.map((h) => `${h.from}->${h.to}[${h.pathClass}]`).join(' ; ') || '(directa)';
  items.push(
    item('path', 'PRE', 'Ruta de upgrade soportada', unsupported ? 'FAIL' : validation ? 'WARN' : 'OK', path, UPGRADE_PATHS),
  );

  // Solo si el DESTINO sigue en Solr: si pasa a Search Enterprise, Solr se desmantela (no se actualiza).
  if (input.sourceSearch.toUpperCase() === 'SOLR' && input.targetSearch.toUpperCase() === 'SOLR') {
    items.push(
      item('solr-first', 'PRE', 'Search Services (Solr) actualizado antes del repositorio', 'PENDING', 'subir Search Services antes que el repositorio', SEARCH_SERVICES),
    );
  }
  if (requiresSolrRemoval(input.targetVersion, input.targetEdition)) {
    const ok = input.targetSearch.toUpperCase() !== 'SOLR';
    items.push(
      item('solr-off', 'PRE', 'Solr desmantelado (26.x: Solr no soportado, CE y EE)', ok ? 'OK' : 'FAIL', `motor destino: ${input.targetSearch}`, REINDEX_APP),
    );
  }

  items.push(item('backup-db', 'PRE', 'Backup de BD verificado/creado', 'PENDING', 'ejecutar migrator_run_steps (backup-source-db)', DB_PATCH));
  items.push(item('backup-store', 'PRE', 'Backup del content store + manifest (SHA-256)', 'PENDING', 'ejecutar migrator_backup', UPGRADE_PATHS));
  items.push(
    item('schema-pk', 'PRE', 'Esquema PostgreSQL con PK/unicidad completos (6 tablas criticas)', 'PENDING', 'ejecutar migrator_schema_check', DB_PATCH),
  );
  items.push(item('cdc', 'PRE', 'Sin replicacion logica (CDC) activa en el origen', 'PENDING', 'ejecutar migrator_schema_check', UPGRADE_PATHS));
  items.push(item('modules', 'PRE', 'Modulos/customizaciones del origen inventariados y revisados', 'PENDING', `ejecutar migrator_source_stack; AMPs/JARs compatibles con ${input.targetVersion}`, UPGRADE_PATHS));
  items.push(item('models', 'PRE', 'Modelos de contenido: JAR del instalador validado y cargado en todos los hops', 'PENDING', 'el instalador aporta target.modelsJar (o confirma que no hay modelos propios)', UPGRADE_PATHS));
  items.push(item('coherence', 'PRE', 'Coherencia DB <-> content store sin referencias colgantes', 'PENDING', 'ejecutar migrator_coherence', UPGRADE_PATHS));
  items.push(item('gates', 'PRE', gatesText(input), 'PENDING', 'gates de breaking changes', UPGRADE_PATHS));
  items.push(item('estimate', 'PRE', 'Estimacion de ventana de corte (benchmark)', 'PENDING', 'ejecutar migrator_estimate', DB_PATCH));
  items.push(item('provisioned', 'PRE', 'Destino provisionado (o externo confirmado)', 'PENDING', 'ejecutar migrator_provision', UPGRADE_PATHS));

  items.push(item('coherence-post', 'POST', 'Coherencia tras la migracion (dangling=0)', 'PENDING', 'ejecutar migrator_coherence', UPGRADE_PATHS));
  const searchEnterprise = input.targetSearch.toUpperCase() !== 'SOLR';
  items.push(
    item(
      'reindex',
      'POST',
      searchEnterprise
        ? 'Indice regenerado (Reindexing app; Total indexed documents)'
        : 'Indice regenerado (Solr tracking de los cores alfresco/archive)',
      'PENDING',
      'ejecutar migrator_run_steps (reindex)',
      searchEnterprise ? REINDEX_APP : SEARCH_SERVICES,
    ),
  );
  items.push(item('verify', 'POST', 'Conteos de nodos/refs y content store verificados (ACL manual)', 'PENDING', 'ejecutar migrator_verify_target', UPGRADE_PATHS));
  items.push(item('origin', 'POST', 'Origen retenido / rollback disponible (no destructivo)', 'OK', 'origen intacto hasta validar el destino', UPGRADE_PATHS));

  return items;
}

/** Hechos durables del proyecto con los que se resuelve el checklist. */
export interface ChecklistFacts {
  /** Ultima evidencia por clave (`evidence.jsonl`). */
  evidence: Map<string, { status: ChecklistStatus; detail: string; at: string }>;
  /** Pasos con algun checkpoint OK (no dry-run). */
  stepsOk: Set<string>;
  /** El DESTINO completo la ruta (ultimo hop registrado) y su smoke fue OK. */
  finalReached: boolean;
  /** Instante en que se registro el ultimo hop. */
  finalAt?: string;
}

/**
 * Resuelve el estado de cada item con la EVIDENCIA registrada (tools de chequeo, checkpoints y hops).
 * Sin evidencia el item conserva su estado (PENDING): nunca se da un OK sin prueba.
 */
export function applyEvidence(items: ChecklistItem[], facts: ChecklistFacts): ChecklistItem[] {
  const fromEvidence = (key: string, after?: string): Partial<ChecklistItem> | undefined => {
    const e = facts.evidence.get(key);
    if (!e || (after && e.at < after)) return undefined;
    return { status: e.status, detail: e.detail };
  };
  const fromStep = (step: string, detail: string): Partial<ChecklistItem> | undefined =>
    facts.stepsOk.has(step) ? { status: 'OK', detail } : undefined;
  const resolvers: Record<string, () => Partial<ChecklistItem> | undefined> = {
    'backup-db': () => fromStep('backup-source-db', 'dump del origen creado y copia verificada en el DESTINO'),
    'backup-store': () => fromEvidence('backup-store'),
    'schema-pk': () => fromEvidence('schema-pk'),
    cdc: () => fromEvidence('cdc'),
    coherence: () => fromEvidence('coherence'),
    gates: () => (facts.finalReached ? { status: 'OK', detail: 'hops completados con smoke OK en cada version' } : undefined),
    estimate: () => fromEvidence('estimate'),
    modules: () => fromEvidence('modules'),
    models: () => fromEvidence('models'),
    provisioned: () => fromStep('provision-hop', 'destino provisionado por provision-hop'),
    'coherence-post': () => (facts.finalReached ? fromEvidence('coherence', facts.finalAt) : undefined),
    reindex: () => fromStep('reindex', 'reindex ejecutado en la version final'),
    verify: () => (facts.finalReached ? fromEvidence('verify', facts.finalAt) : undefined),
  };
  return items.map((i) => ({ ...i, ...(resolvers[i.key]?.() ?? {}) }));
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
