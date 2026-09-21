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
import { breakingChangeGates, requiresSolrRemoval } from './domain/upgrade-paths.js';

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
    content: `# Gates de breaking changes y rutas de upgrade\n\n${lines.join('\n')}\n\nRutas soportadas: 7.x < 7.2 requiere validacion del fabricante; 7.4 -> 25.3 -> 26.2. Subir Search Services (Solr) antes que el repositorio.
Regla: NO se salta de version; la migracion se hace por la cadena de hops EN ORDEN (p.ej. 7.1 -> 7.4 -> 25.3 -> 26.2). Los saltos \`UNSUPPORTED\` se rechazan.\n`,
  };
}

export function storageMountsSkill(): SkillContent {
  return {
    name: 'alfresco-storage-mounts',
    description:
      'Riesgos de almacenamiento en VM Linux con NAS/SAN: content store sobre NFS/CIFS/LUN, mismo backing store origen/destino (corrompe la copia), doble salto por red y copia server-side. Cargar al planificar o revisar la copia de contenido.',
    content: `# Almacenamiento del content store en VM (NAS/SAN)

Es comun montar el content store en un volumen remoto:
- **NFS/NFS4** (NAS Linux), **CIFS/SMB** (NAS Windows), **LUN iSCSI/FC** (SAN, se ve como xfs/ext4 pero el device es \`/dev/mapper/mpath*\`).

Riesgos y reglas:
1. **Mismo backing store** (mismo export NFS, mismo share CIFS o mismo LUN) en origen y destino: la copia **se corrompe** (escribe sobre el origen). \`migrator_mount_check\` lo marca como **BLOCKER** cuando es demostrable y \`copy-content\` aborta.
2. **Doble salto por red**: si ambos extremos son remotos, una copia **server-side** (rsync remoto o herramienta del NAS) evita pasar por el host de operacion.
3. **Rendimiento impredecible**: \`rsync\` sobre NFS/CIFS es sensible a latencia; valorar snapshots del NAS/SAN para el corte.
4. **Permisos/ownership**: NFS con \`root_squash\` o CIFS pueden no preservar el uid/gid de Alfresco; verificar tras la copia.
5. **Snapshots de almacenamiento** (NAS/SAN) son una via de rollback rapida y coherente, preferible a copia por red para volumenes grandes.

## Lo que NO se puede saber desde el guest (preguntar al humano)

La VM **no ve** el datastore del hipervisor ni el backend fisico del SAN. Si \`migrator_mount_check\`
devuelve \`requiresHumanConfirmation=true\` (discos virtuales \`virtio/vmw\`, transporte \`spi\`, o vendor
\`VMware\`/\`QEMU\`), **no concluyas por tu cuenta**: usa la via de preguntas del arnes (\`ask_user_question\`) para
confirmar con el humano:

- "El content store origen (\`/repositorio\`) y el destino ¿residen en **datastores/LUN distintos** a nivel de vSphere/Proxmox? ¿Comparten almacenamiento fisico?"
- Si comparten datastore/LUN → tratar como mismo backing store (BLOCKER funcional aunque no demostrable desde el guest).

El vendor/model crudo del dispositivo lo devuelve la tool como **hechos**: es el humano (o el LLM con
ese dato) quien decide, no una lista de vendors en el codigo.

Diagnostico: \`migrator_mount_check\` (read-only) expone los montajes y dispositivos de origen y destino,
clasifica solo lo demostrable y marca cuando hace falta confirmacion humana.
`,
  };
}

export function planningHeuristicsSkill(): SkillContent {
  return {
    name: 'alfresco-planning-heuristics',
    description:
      'Heuristicas y umbrales para elegir estrategia de contenido/BD/indice y estimar la ventana de corte (perfil de documentos, cuello de botella, auditoria elevada). Cargar al planificar o al interpretar migrator_strategy/migrator_estimate.',
    content: `# Planificacion: estrategia y ventana

Las tools \`migrator_strategy\` y \`migrator_estimate\` devuelven **hechos + un valor por defecto heuristico**.
Ajusta el juicio al contexto; no son verdades absolutas.

## Estrategia de contenido (C1-C5)
- **Muchos documentos (>1M)**: el cuello son las operaciones por fichero -> snapshot si hay acceso al almacenamiento, si no bulk+delta. La API/CMIS es inviable.
- **Pocos y muy grandes (media >100MB)**: limitado por ancho de banda -> stream paralelo o snapshot.
- **Repos pequeno/heterogeneo (<100k ficheros y <200GB)**: export/import o API/CMIS.
- **Perfil mixto**: copia bulk + delta.

## BD (D1-D3)
- Con acceso al almacenamiento -> **D1 snapshot** (mas rapido, coherente).
- Sin el -> **D2 dump/restore**.
- **D3 CDC/replicacion logica**: solo con REPLICA IDENTITY y tablas con PK/unicidad (ver skill de integridad). Riesgo alto de duplicados.

## Indice (I1-I2)
- >1M nodos -> **reindex por lotes de ID**; si no, **reindex estandar**. Los indices NUNCA se migran.

## Ventana de corte
- Cuello tipico: **schema-upgrade** (mas saltos = mas tiempo; auditoria muy elevada lo encarece).
- Palancas: purgar auditoria, paralelismo, content store compartido, snapshots del NAS/SAN.
- Confianza **LOW** si no hay throughput medido (benchmark); recalibrar con datos reales.

## Deltas y cutover
- Prepublish (bulk) + delta final durante la ventana; el delta depende de la tasa de cambio diaria.
`,
  };
}

export function readinessChecklistSkill(): SkillContent {
  return {
    name: 'alfresco-readiness-checklist',
    description:
      'Checklist pre/post-cutover de una migracion ACS a 26.x (version/edicion-aware): ruta, Solr, backup, esquema, CDC, coherencia, gates, provision, reindex, verificacion. Cargar antes del corte o al interpretar migrator_checklist.',
    content: `# Checklist de preparacion (pre/post-cutover)

\`migrator_checklist\` genera una **linea base** version-aware; anade o quita items segun el contexto.

## Pre-cutover
- Ruta de upgrade soportada (los saltos \`REQUIRES_VALIDATION\` exigen contacto con el fabricante).
- Search Services (Solr) actualizado **antes** que el repositorio (si el origen es Solr).
- Enterprise >= 26: **Solr desmantelado** y regenerado con Search Enterprise.
- **Backup verificado/creado**: dump de BD + content store con manifiesto SHA-256 + snapshot de config.
- **Esquema PostgreSQL con PK/unicidad** completos y **sin replicacion logica (CDC)** activa.
- Modulos/customizaciones revisados (Extension Inspector) para la version destino.
- **Coherencia DB <-> content store** sin referencias colgantes.
- Gates de breaking changes: Java 21/Tomcat 11, ActiveMQ 6.x con autenticacion, eventos v2, Solr-off (EE).
- Estimacion de ventana con benchmark; destino provisionado (o externo confirmado).
- Almacenamiento: verificar que origen y destino no comparten datastore/LUN (skill de montajes).

## Post-cutover
- Coherencia con **dangling=0**.
- **Indice regenerado** (Reindexing app o Solr tracking) y verificado (\`Total indexed documents\`).
- Conteos de nodos, checksums y ACL verificados contra el origen.
- **Origen retenido** (rollback trivial antes del switch DNS).

Cada item debe poder responderse con **evidencia** de una tool; si falta, es PENDING, no OK.
`,
  };
}

export function migrationPlaybookSkill(): SkillContent {
  return {
    name: 'alfresco-migration-playbook',
    description:
      'Flujo operativo de una migracion ACS a 26.x: assessment, ensayo en clone/TEST, drift a PROD, backup no destructivo, pasos de ejecucion (preflight, dump, copia, restore, schema-upgrade, reindex, verify), coherencia y forense de colgantes, gates GO/NO-GO. Cargar al ejecutar o supervisar una migracion. Disparadores: "iniciar migracion", "continuar migracion" (basta con eso).',
    content: `# Playbook de migracion ACS -> 26.x

## Entradas minimas (usuario sin experiencia)
Basta con una de estas frases; NO pidas un prompt detallado.

- **"iniciar migracion"** (o "empezar"): carga esta skill y ejecuta el runbook:
  1. resuelve el **proyecto del workspace** y su estado (\`.migrator\`); si no hay proyecto, \`migrator_wizard\`;
  2. verificaciones **READ-ONLY** (\`migrator_verify_target\`, \`migrator_mount_check\`, \`migrator_coherence\`,
     \`migrator_schema_check\`, \`migrator_estimate\`);
  3. determina **el hop que toca** y si el DESTINO esta en su version (guarda de hops);
  4. **dry-run** de los pasos del hop (\`migrator_run_steps\`, \`execute=false\`);
  5. presenta **plan + evidencia** y pide **aprobacion**;
  6. con aprobacion, ejecuta (\`execute=true\`) y verifica (\`verify-target\`);
  7. registra el intento (\`migrator_rehearsal_record\`).
  Si el DESTINO **no** esta en la version del hop, **no escribas**: indica que hay que provisionar esa version y para.
- **"continuar migracion"** (o "sigue"/"retoma"): lee el estado durable (\`.migrator/hops.jsonl\`,
  \`checkpoints.jsonl\`, experiencia), situa el punto de reanudacion (\`resumeFrom\`), **recupera el contexto de
  chats anteriores del mismo workspace** con \`session_search\`/\`session_event_read\` (decisiones, plan,
  aprobaciones) y continua desde ahi con el mismo runbook. NO repitas el assessment si ya hay estado.

Pide por \`ask_user_question\` **solo** lo imprescindible que no puedas resolver del workspace/estado.

## Ante una peticion amplia (p.ej. "iniciar evaluacion de migracion de version alfresco")
No esperes un prompt perfecto ni inventes datos. Empieza por el **assessment** (fuente de verdad), propone
un **plan de ejecucion** por fases y **pide** lo que falte por la via de preguntas del arnes
(\`ask_user_question\`):
- **workspace/proyecto**: el proyecto vive en el **workspace** (un YAML en la carpeta); las tools lo resuelven solas (no pases ruta). Si no existe, crealo con \`migrator_wizard\` (lo escribe en el workspace).
- **almacenamiento**: si origen y destino comparten datastore/LUN (NAS/SAN/VM) — \`migrator_mount_check\`.
- **acceso**: BD/REST del origen, host SSH del destino, si el Postgres del destino es alcanzable.
- **decisiones**: ruta de upgrade (hops), estrategia (C/D/I) y ventana de corte.
Recuerda que el entorno es **solo-lectura** por defecto (\`MIGRATOR_MODE=readonly\`): para el ensayo real
hay que habilitar \`MIGRATOR_MODE=write\` y aprobar; no lo asumas.

1. **Assessment** (\`migrator_assess\`): inventario desde la fuente de verdad (REST + JDBC + store). Nunca usar indices de busqueda.
2. **Planificacion**: \`migrator_upgrade_path\`, \`migrator_strategy\`, \`migrator_estimate\`, \`migrator_checklist\`.
3. **Preflight**: \`migrator_schema_check\` (PK/UNIQUE + CDC), \`migrator_coherence\`.
4. **Ensayo en clone/TEST**: \`migrator_run_steps\` + \`migrator_rehearsal_record\`. Si falla, restaurar y reanudar (\`resume=true\`).
5. **Paridad a PROD**: \`migrator_environment_parity\`; sin ensayo validado o con drift BLOCKER, PROD se bloquea.
6. **Backup no destructivo**: \`migrator_backup\` (BD + store + manifiesto SHA-256). El origen nunca se modifica.
7. **Ejecucion en destino**: preflight-target -> backup-source-db -> copy-content -> restore-target-db -> schema-upgrade -> reindex -> verify-target.
8. **Post**: coherencia con dangling=0, reindex verificado, conteos/checksums/ACL, origen retenido para rollback.

Reglas duras: el ORIGEN es inmutable; las escrituras van solo al DESTINO y con aprobacion; los indices de busqueda se regeneran, nunca se migran; no ejecutar CDC sin REPLICA IDENTITY; **nunca migrar de una version a otra NO soportada** (se respeta la cadena de hops en orden; \`UNSUPPORTED\` se rechaza y \`REQUIRES_VALIDATION\` exige validacion del fabricante).

Recuperacion: si un paso se interrumpe (outcome unknown), NO reintentes a ciegas. Las tools read-only se pueden reintentar; para las de escritura, consulta \`migrator_run_status\` (checkpoints), verifica el estado externo y reanuda con \`migrator_run_steps\` y \`resume=true\`.
`,
  };
}

export async function allSkills(): Promise<SkillContent[]> {
  return [
    await loadRecommendationSkill(),
    upgradeGatesSkill(),
    planningHeuristicsSkill(),
    readinessChecklistSkill(),
    migrationPlaybookSkill(),
    storageMountsSkill(),
  ];
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
  register(planningHeuristicsSkill());
  register(readinessChecklistSkill());
  register(migrationPlaybookSkill());
  register(storageMountsSkill());
  // La skill de recomendaciones se carga desde disco (async): se registra cuando este lista.
  void loadRecommendationSkill().then(register).catch(() => undefined);
}
