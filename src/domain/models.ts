/**
 * JAR de MODELOS DE CONTENIDO aportado por el INSTALADOR HUMANO (`target.modelsJar`): los modelos son parte
 * del producto del cliente; el migrador no los fabrica, solo VALIDA el JAR y lo despliega en TODOS los hops
 * (7.4, 25.3, 26.x) para que los tipos/aspectos propios existan aunque el codigo no este migrado.
 *
 * Validacion (antes de tocar el destino): el JAR debe traer al menos un contexto Spring en
 * `alfresco/extension/*-context.xml` (el repositorio importa `classpath*:alfresco/extension/*-context.xml`,
 * verificado en 26.2) y al menos un XML de modelo de diccionario valido.
 */
import { XMLParser } from 'fast-xml-parser';
import { runShell } from '../infra/exec.js';

export const DICTIONARY_NS = 'http://www.alfresco.org/model/dictionary/1.0';

export interface ContentModel {
  /** `prefix:nombre` del atributo `name`. */
  name: string;
  /** Entrada del JAR. */
  origin: string;
  namespaces: Array<{ uri: string; prefix: string }>;
  imports: string[];
  /** Restricciones `type="class"`: necesitan una clase Java (el codigo migrado), no bastan con el JAR. */
  classConstraints: string[];
}

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', isArray: (n) => ['namespace', 'import', 'constraint', 'parameter'].includes(n) });

/** Parsea un XML de modelo; `undefined` si no es un modelo de diccionario. */
export function parseModel(xml: string, origin: string): ContentModel | undefined {
  if (!xml.includes(DICTIONARY_NS) || !/<model[\s>]/.test(xml)) return undefined;
  let doc: Record<string, unknown>;
  try {
    doc = parser.parse(xml) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  const model = doc.model as Record<string, unknown> | undefined;
  if (!model || String(model['@_xmlns'] ?? '') !== DICTIONARY_NS) return undefined;
  const list = (node: unknown, key: string): Array<Record<string, unknown>> =>
    ((node as Record<string, unknown> | undefined)?.[key] as Array<Record<string, unknown>> | undefined) ?? [];
  return {
    name: String(model['@_name'] ?? origin),
    origin,
    namespaces: list(model.namespaces, 'namespace').map((n) => ({ uri: String(n['@_uri'] ?? ''), prefix: String(n['@_prefix'] ?? '') })),
    imports: list(model.imports, 'import').map((i) => String(i['@_uri'] ?? '')),
    classConstraints: list(model.constraints, 'constraint')
      .filter((c) => String(c['@_type'] ?? '') === 'class')
      .map((c) => String(list(c, 'parameter').find((p) => p['@_name'] === 'className')?.value ?? c['@_name'] ?? '?')),
  };
}

export interface ModelsJarCheck {
  ok: boolean;
  contexts: string[];
  models: ContentModel[];
  /** Id del modulo (`alfresco/module/<id>/`) si es un JAR de modulo. */
  moduleId?: string;
  /** Avisos (no bloquean): contenido inesperado en un JAR de modelos. */
  warnings: string[];
  reason?: string;
}

/** Contexto de un JAR de extension (`alfresco/extension/*-context.xml`) o de modulo (`alfresco/module/<id>/module-context.xml`). */
const EXTENSION_CONTEXT = /^alfresco\/extension\/[^/]+-context\.xml$/;
const MODULE_CONTEXT = /^alfresco\/module\/([^/]+)\/module-context\.xml$/;

/** Clases Java que la imagen ya trae (producto/frameworks): no hace falta que vayan en el JAR. */
const PLATFORM_PACKAGES = /^(org\.alfresco\.|org\.springframework\.|java\.|javax\.|jakarta\.)/;

/** Contenido que no pinta nada en un JAR de SOLO modelos (restos de build o configuracion que altera el destino). */
const SUSPICIOUS: Array<[RegExp, string]> = [
  [/(^|\/)alfresco-global\.properties$/, 'propiedades de repositorio (alfresco-global.properties): alteran la configuracion del destino'],
  [/(^|\/)log4j2?\.properties$|(^|\/)log4j2?\.xml$/, 'configuracion de logging'],
  [/^docker\//, 'ficheros docker (restos de build)'],
  [/(^|\/)rebel\.xml$/, 'rebel.xml (JRebel, desarrollo)'],
];

/** Valida el JAR de modelos del instalador (local): cargable, con modelos y sin codigo ausente. */
export async function validateModelsJar(jar: string): Promise<ModelsJarCheck> {
  const listed = await runShell({ name: 'local' }, `unzip -Z1 "${jar}" 2>/dev/null`);
  if (listed.exitCode !== 0) return { ok: false, contexts: [], models: [], warnings: [], reason: `no es un JAR legible: ${jar}` };
  const entries = listed.stdout.split('\n').filter((e) => e && !e.endsWith('/'));
  const read = async (entry: string): Promise<string> =>
    (await runShell({ name: 'local' }, `unzip -p "${jar}" "${entry.replace(/"/g, '\\"')}"`)).stdout;
  const contexts = entries.filter((e) => EXTENSION_CONTEXT.test(e) || MODULE_CONTEXT.test(e));
  const moduleId = contexts.map((c) => MODULE_CONTEXT.exec(c)?.[1]).find(Boolean);
  const warnings: string[] = [];
  if (moduleId && !entries.includes(`alfresco/module/${moduleId}/module.properties`)) {
    return { ok: false, contexts, models: [], warnings, reason: `modulo ${moduleId} sin module.properties (el repositorio no lo cargaria)` };
  }
  const models: ContentModel[] = [];
  for (const entry of entries.filter((e) => e.endsWith('.xml') && !contexts.includes(e))) {
    const model = parseModel(await read(entry), entry);
    if (model) models.push(model);
  }
  if (contexts.length === 0) {
    return { ok: false, contexts, models, warnings, reason: 'sin contexto Spring (alfresco/extension/*-context.xml o alfresco/module/<id>/module-context.xml): el repositorio no cargaria los modelos' };
  }
  if (models.length === 0) return { ok: false, contexts, models, warnings, reason: 'sin modelos de diccionario validos' };
  // Codigo AUSENTE: clases propias referenciadas en los contextos que no van en el JAR => Alfresco no arranca.
  const classes = new Set(entries.filter((e) => e.endsWith('.class')).map((e) => e.replace(/\.class$/, '').replace(/\//g, '.')));
  const missing = new Set<string>();
  for (const ctx of contexts) {
    for (const m of (await read(ctx)).matchAll(/class="([\w.$]+)"/g)) {
      const cls = m[1]!;
      if (!PLATFORM_PACKAGES.test(cls) && !classes.has(cls)) missing.add(cls);
    }
  }
  if (missing.size) {
    return { ok: false, contexts, models, warnings, reason: `el contexto referencia clases que no van en el JAR (Alfresco no arrancaria): ${[...missing].join(', ')}` };
  }
  for (const [pattern, label] of SUSPICIOUS) {
    const hits = entries.filter((e) => pattern.test(e));
    if (hits.length) warnings.push(`${label}: ${hits.join(', ')}`);
  }
  if (moduleId) {
    warnings.push(`modulo "${moduleId}": en la version final no debe instalarse otro modulo con el mismo id ni que vuelva a registrar estos modelos`);
  }
  return { ok: true, contexts, models, warnings, ...(moduleId ? { moduleId } : {}) };
}

/**
 * Namespaces que USAN los nodos del ORIGEN (tipos y aspectos). Solo lectura: define que modelos propios
 * deben existir en el destino para que esos nodos sigan teniendo definicion.
 */
export const NAMESPACES_IN_USE_SQL = `SELECT DISTINCT ns.uri AS uri FROM alf_node n
  JOIN alf_qname q ON q.id = n.type_qname_id JOIN alf_namespace ns ON ns.id = q.ns_id
UNION
SELECT DISTINCT ns.uri AS uri FROM alf_node_aspects a
  JOIN alf_qname q ON q.id = a.qname_id JOIN alf_namespace ns ON ns.id = q.ns_id`;

/** Namespaces del propio producto (sistema y modelos estandar): no requieren JAR del instalador. */
const STANDARD_NAMESPACE_PREFIXES = ['http://www.alfresco.org/', 'http://www.alfresco.com/', 'http://www.jcp.org/', 'http://www.w3.org/'];

export const isStandardNamespace = (uri: string): boolean => !uri || STANDARD_NAMESPACE_PREFIXES.some((p) => uri.startsWith(p));

export interface ModelsCoverage {
  /** Namespaces propios en uso en el origen. */
  custom: string[];
  /** En uso, no cubiertos por el JAR y no declarados como no necesarios: BLOQUEAN. */
  missing: string[];
  /** Declarados por el humano como no necesarios (target.modelsNotRequired). */
  accepted: string[];
}

/** Cobertura del JAR del instalador frente a los namespaces propios en uso en el origen. */
export function modelsCoverage(inUse: string[], models: ContentModel[], notRequired: string[] = []): ModelsCoverage {
  const custom = [...new Set(inUse.filter((uri) => !isStandardNamespace(uri)))].sort();
  const defined = new Set(models.flatMap((m) => m.namespaces.map((n) => n.uri)));
  const accept = new Set(notRequired);
  const accepted = custom.filter((uri) => !defined.has(uri) && accept.has(uri));
  const missing = custom.filter((uri) => !defined.has(uri) && !accept.has(uri));
  return { custom, missing, accepted };
}
