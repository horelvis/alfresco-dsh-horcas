/**
 * POLITICA DE REINDEX segun tamaño y VENTANA DE CORTE (no es una herramienta: es la decision de COMO y
 * CUANDO regenerar el indice, con los pasos concretos por motor). Para repositorios de millones de
 * documentos con ventana acotada, el indice no cabe dentro del corte: se pre-indexa antes y se cubre el
 * delta despues, o se indexan metadatos (y permisos) primero y el contenido online.
 *
 * Fuentes: Hyland Docs (Search Enterprise Re-indexing app: reindexByIds/ByDate, remote partitioning,
 * metadata/content/path por separado; Search Services full reindex / backup de cores) y acs-deployment
 * (Community 26.2: Alfresco Search Community = batch-indexing con watermark reindexByDate).
 */
import { parseVersion } from './versions.js';

export type ReindexPolicy = 'POST_CUTOVER_ONLINE' | 'METADATA_FIRST' | 'PRE_INDEX_DELTA';
export type SearchFamily = 'SEARCH_COMMUNITY' | 'SEARCH_ENTERPRISE' | 'SOLR';

export interface ReindexPolicyInput {
  nodes: number;
  /** Nodos/s de la pasada de metadatos (medir con un piloto; por defecto el supuesto del estimador). */
  metadataNodesPerSec: number;
  /** Cuanto mas lenta es la pasada de CONTENIDO (extraccion de texto/transformaciones) que la de metadatos. */
  contentPassFactor: number;
  /** Ventana de corte disponible (horas); sin ventana no se exige que el indice quepa. */
  windowHours?: number;
  engine: string;
  edition: string;
  targetVersion: string;
}

export interface ReindexPlan {
  policy: ReindexPolicy;
  family: SearchFamily;
  metadataHours: number;
  contentHours: number;
  fitsWindow: boolean;
  rationale: string;
  steps: string[];
}

export function searchFamily(engine: string, edition: string, targetVersion: string): SearchFamily {
  if (engine.toUpperCase() === 'SOLR') return 'SOLR';
  if (edition.toUpperCase() === 'EE') return 'SEARCH_ENTERPRISE';
  // Community con Elasticsearch/OpenSearch: Search Community (batch-indexing) desde 26.2.
  const [major = 0, minor = 0] = parseVersion(targetVersion);
  return major > 26 || (major === 26 && minor >= 2) ? 'SEARCH_COMMUNITY' : 'SOLR';
}

const STEPS: Record<SearchFamily, Record<ReindexPolicy, string[]>> = {
  SEARCH_COMMUNITY: {
    POST_CUTOVER_ONLINE: [
      'Desplegar alfresco-elasticsearch-batch-indexing (Search Community) con index.subsystem.name=elasticsearch.',
      'SEMBRAR el watermark reindexByDate en MIN(alf_transaction.commit_time_ms) antes de arrancarlo (sin semilla empieza en "now" y NUNCA indexa lo migrado); alfresco.reindex.continuous.maxGapAge=0.',
      'Subir ALFRESCO_REINDEX_CONTINUOUS_MAXWINDOW (p.ej. 7d) para recorrer el historico; el delta posterior es continuo.',
      'Declarar el prefixes-file con los namespaces de los modelos propios (si falta uno, esos nodos no se indexan sin aviso).',
    ],
    METADATA_FIRST: [
      'Search Community no separa metadatos y contenido: usar PRE_INDEX_DELTA si el indice no cabe en la ventana.',
    ],
    PRE_INDEX_DELTA: [
      'Antes del corte: batch-indexing contra la COPIA ya migrada (ensayo final) con el watermark sembrado en el primer commit_time_ms; recorre el historico en paralelo.',
      'En el corte: conservar el indice y su watermark (alfresco-reindex-state); al arrancar PROD el cursor continua y cubre solo el delta.',
      'Solo valido si la BD de PROD conserva los mismos IDs/commit_time que la copia indexada.',
    ],
  },
  SEARCH_ENTERPRISE: {
    POST_CUTOVER_ONLINE: [
      'Arrancar live-indexing y lanzar la Re-indexing app (reindexByIds, rango completo) con el repositorio en servicio.',
    ],
    METADATA_FIRST: [
      'En la ventana: Re-indexing app reindexByIds con metadataIndexingEnabled=true, contentIndexingEnabled=false (indexa permisos: la busqueda por metadatos queda operativa).',
      'Tras el corte, online: segunda pasada con metadataIndexingEnabled=false, contentIndexingEnabled=true por rangos de ID.',
      'Escalar con remote partitioning (alfresco.reindex.partitioning.type=master/worker, grid-size) y concurrentProcessors; transform por debajo de ~10 consumidores.',
    ],
    PRE_INDEX_DELTA: [
      'Antes del corte: reindexByIds particionado contra la copia migrada (metadatos primero).',
      'En el corte: live-indexing + reindexByDate desde el instante del snapshot menos un solape.',
      'Despues: pasada de contenido online por rangos de ID.',
    ],
  },
  SOLR: {
    POST_CUTOVER_ONLINE: [
      'Full reindex: parar Solr, borrar los datos de los cores alfresco/archive y arrancar; Solr rastrea desde cero con el repositorio en servicio (busquedas incompletas mientras tanto).',
    ],
    METADATA_FIRST: [
      'Rastreo con alfresco.index.transformContent=false (solo metadatos) y reactivar el contenido despues.',
    ],
    PRE_INDEX_DELTA: [
      'Construir los cores contra la copia migrada antes del corte; hacer backup de Solr ANTES que de la BD.',
      'En el corte: restaurar los cores; Solr rastrea el delta por alf_transaction (mismos IDs de transaccion/ACL que la copia).',
    ],
  },
};

export function reindexPlan(input: ReindexPolicyInput): ReindexPlan {
  const family = searchFamily(input.engine, input.edition, input.targetVersion);
  const metadataHours = input.nodes / Math.max(1, input.metadataNodesPerSec) / 3600;
  const contentHours = metadataHours * input.contentPassFactor;
  const window = input.windowHours;
  let policy: ReindexPolicy;
  let rationale: string;
  if (window === undefined || metadataHours + contentHours <= window) {
    policy = 'POST_CUTOVER_ONLINE';
    rationale = window === undefined ? 'sin ventana de corte declarada: reindex online tras el corte' : `el reindex completo (~${(metadataHours + contentHours).toFixed(1)} h) cabe en la ventana (${window} h)`;
  } else if (metadataHours <= window && family !== 'SEARCH_COMMUNITY') {
    policy = 'METADATA_FIRST';
    rationale = `el reindex completo no cabe en ${window} h, pero los metadatos (~${metadataHours.toFixed(1)} h) si: contenido online despues`;
  } else {
    policy = 'PRE_INDEX_DELTA';
    rationale = `ni los metadatos (~${metadataHours.toFixed(1)} h) caben en ${window} h: pre-indexar antes del corte y cubrir el delta`;
  }
  return { policy, family, metadataHours, contentHours, fitsWindow: window === undefined || metadataHours + contentHours <= window, rationale, steps: STEPS[family][policy] };
}
