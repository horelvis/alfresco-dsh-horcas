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
\`VMware\`/\`QEMU\`), **no concluyas por tu cuenta**: usa la via de preguntas del arnes (\`ask_user\`) para
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
  return [await loadRecommendationSkill(), upgradeGatesSkill(), migrationPlaybookSkill(), storageMountsSkill()];
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
  register(storageMountsSkill());
  // La skill de recomendaciones se carga desde disco (async): se registra cuando este lista.
  void loadRecommendationSkill().then(register).catch(() => undefined);
}
