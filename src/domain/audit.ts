/**
 * AUDITORIA determinista del ensayo (Nivel 0): recalcula desde las FUENTES (checkpoints, hops,
 * experiencia, journal, evidencia y checklist) y CONTRADICE el resumen cuando no cuadra. No consulta el
 * origen ni el destino: solo el estado durable local. Devuelve hallazgos con severidad; un FAIL impide
 * declarar el informe "validado".
 *
 * Es el "hecho" del que el subagente auditor (Nivel 1) parte y lo que la puerta del arnes (Nivel 2)
 * exige antes de emitir el informe final o el corte a PROD.
 */
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { ProjectConfig } from './project-config.js';
import { resolveUpgradePath } from './upgrade-paths.js';
import { loadCheckpoints } from './checkpoints.js';
import { loadHopProgress } from './hops.js';
import { loadExperiences } from './experience.js';
import { loadJournal } from './journal.js';
import { checklistFacts, latestEvidence } from './evidence.js';
import { applyEvidence, buildChecklist } from './checklist.js';
import { executedRuns, shareAccessUrl } from './report.js';

export type AuditSeverity = 'FAIL' | 'WARN' | 'INFO';

export interface AuditFinding {
  code: string;
  severity: AuditSeverity;
  detail: string;
}

export interface AuditResult {
  at: string;
  project: string;
  stage: string;
  fails: number;
  warns: number;
  findings: AuditFinding[];
}

export function auditFile(state: string): string {
  return path.join(state, 'audit.jsonl');
}

/** Anota el resultado de la auditoria (`.migrator/audit.jsonl`), para la puerta del arnes. */
export async function recordAudit(state: string, result: AuditResult): Promise<void> {
  try {
    await mkdir(state, { recursive: true });
    await appendFile(auditFile(state), JSON.stringify(result) + '\n', 'utf8');
  } catch {
    // La auditoria no debe romper la tool que la produce.
  }
}

/** Ultima auditoria del proyecto. */
export async function latestAudit(state: string, project: string): Promise<AuditResult | undefined> {
  try {
    const text = await readFile(auditFile(state), 'utf8');
    let latest: AuditResult | undefined;
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as AuditResult;
        if (entry.project === project && (!latest || entry.at >= latest.at)) latest = entry;
      } catch {
        // linea corrupta: se ignora
      }
    }
    return latest;
  } catch {
    return undefined;
  }
}

const fail = (findings: AuditFinding[], code: string, detail: string): void => void findings.push({ code, severity: 'FAIL', detail });
const warn = (findings: AuditFinding[], code: string, detail: string): void => void findings.push({ code, severity: 'WARN', detail });
const info = (findings: AuditFinding[], code: string, detail: string): void => void findings.push({ code, severity: 'INFO', detail });

/**
 * Audita el ensayo del proyecto contra su estado durable. `at` permite fijar la marca temporal (tests).
 */
export async function runAudit(project: ProjectConfig, state: string, at = new Date().toISOString()): Promise<AuditResult> {
  const findings: AuditFinding[] = [];
  const hops = resolveUpgradePath(project.source.version, project.target.version);
  const expectedHops = hops.map((h) => h.to);
  const progress = await loadHopProgress(state, project.project);
  const checkpoints = await loadCheckpoints(state, project.project);
  const experience = (await loadExperiences(state, project.project)).find((r) => r.stage === project.stage);
  const journal = await loadJournal(state, project.project);
  const evidence = await latestEvidence(state, project.project);
  const lastHop = hops.at(-1)?.to;
  const done = new Set(progress.map((p) => p.to));
  const finalReached = lastHop ? done.has(lastHop) : checkpoints.some((c) => c.step === 'smoke-boot' && c.status === 'OK');

  // A5 · ruta: los hops completados deben pertenecer (y en orden) a la ruta soportada.
  for (const p of progress) {
    if (!expectedHops.includes(p.to)) fail(findings, 'HOP_FUERA_DE_RUTA', `hop completado a ${p.to} no esta en la ruta soportada ${expectedHops.join(' -> ')}`);
  }
  const order = progress.map((p) => expectedHops.indexOf(p.to));
  if (order.some((i) => i === -1) || order.some((v, i) => i > 0 && v < order[i - 1]!)) {
    fail(findings, 'HOPS_DESORDENADOS', `hops completados fuera de orden: ${progress.map((p) => p.to).join(', ')}`);
  }

  // A1 · estado final verificado (smoke + verify), no solo "hop marcado".
  if (finalReached) {
    if (!checkpoints.some((c) => c.step === 'smoke-boot' && c.status === 'OK')) {
      fail(findings, 'SIN_SMOKE_FINAL', 'hop final marcado como completado pero sin smoke-boot OK');
    }
    if (!checkpoints.some((c) => c.step === 'verify-target' && c.status === 'OK')) {
      fail(findings, 'SIN_VERIFY', 'no hay verify-target OK tras el hop final: paridad sin comprobar');
    }
  }

  // A2 · evidencia de paridad y coherencia (no basta con que el informe lo afirme).
  if (finalReached) {
    const parity = evidence.get('verify');
    if (!parity) warn(findings, 'SIN_EVIDENCIA_PARIDAD', 'sin evidencia de paridad (verify-target)');
    else if (parity.status === 'FAIL') fail(findings, 'PARIDAD_FAIL', `paridad con FAIL: ${parity.detail}`);
    const coherence = evidence.get('coherence');
    if (coherence && coherence.status === 'FAIL') fail(findings, 'COHERENCIA_FAIL', `coherencia con FAIL: ${coherence.detail}`);
    if (!coherence) warn(findings, 'SIN_EVIDENCIA_COHERENCIA', 'sin evidencia de coherencia DB <-> content store');
    const models = evidence.get('models');
    if (models && models.status === 'FAIL') fail(findings, 'MODELOS_FAIL', `modelos con FAIL: ${models.detail}`);
  }

  // A3 · checklist: un FAIL del checklist es un FAIL del ensayo; los pendientes, WARN.
  const checklist = applyEvidence(
    buildChecklist({
      project: project.project,
      sourceVersion: project.source.version,
      targetVersion: project.target.version,
      sourceEdition: project.source.edition ?? 'CE',
      targetEdition: project.target.edition ?? 'CE',
      sourceSearch: project.source.search?.engine ?? 'solr',
      targetSearch: project.target.search?.engine ?? 'solr',
      hops: hops.map((h) => ({ from: h.from, to: h.to, pathClass: h.pathClass })),
    }),
    await checklistFacts(state, project.project, hops),
  );
  for (const item of checklist) {
    if (item.status === 'FAIL') fail(findings, 'CHECKLIST_FAIL', `${item.text}`);
    else if (item.status === 'PENDING') warn(findings, 'CHECKLIST_PENDIENTE', `${item.text}`);
  }

  // A4 · experiencia: sin duplicados por runId y coherente con los runs ejecutados.
  if (experience) {
    const ids = experience.attempts.map((a) => a.id);
    const dup = [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))];
    if (dup.length) fail(findings, 'INTENTOS_DUPLICADOS', `la campana repite runIds (un run debe ser UN intento): ${dup.join(', ')}`);
    const runs = executedRuns(checkpoints).map((r) => r.runId);
    const missing = runs.filter((r) => !ids.includes(r));
    if (missing.length) warn(findings, 'RUNS_SIN_INTENTO', `runs ejecutados sin intento en la campana: ${missing.join(', ')}`);
  } else if (finalReached) {
    fail(findings, 'SIN_EXPERIENCIA', 'ensayo completado sin registro de experiencia (no reutilizable/validable en PROD)');
  }

  // A6 · reindex: en la version final debe estar hecho o documentado como decision.
  if (finalReached) {
    const reindexOk = checkpoints.some((c) => c.step === 'reindex' && c.status === 'OK');
    if (!reindexOk) {
      const documented = journal.some((j) => j.kind === 'decision' && /reindex|indice|índice/i.test(j.summary));
      if (documented) info(findings, 'REINDEX_PENDIENTE', 'reindex pendiente, con decision documentada');
      else warn(findings, 'REINDEX_SIN_DECISION', 'reindex no ejecutado y sin decision documentada');
    }
  }

  // A7 · bloqueos del journal abiertos: si el ultimo estado es un blocker sin decision posterior, avisa.
  const lastBlocker = [...journal].reverse().find((j) => j.kind === 'blocker');
  if (lastBlocker) {
    const resolvedAfter = journal.some((j) => j.kind === 'decision' && j.at > lastBlocker.at);
    if (!resolvedAfter) warn(findings, 'BLOQUEO_ABIERTO', `ultimo bloqueo sin decision posterior: ${lastBlocker.summary}`);
  }

  // A8 · URL real de Share (informativo pero util para el cutover): sin proxy, puerto propio.
  const share = shareAccessUrl(project);
  if (share) info(findings, 'SHARE_URL', `Share accesible en ${share}${project.target.stack?.proxy ? '' : ' (sin proxy)'}`);

  const fails = findings.filter((f) => f.severity === 'FAIL').length;
  const warns = findings.filter((f) => f.severity === 'WARN').length;
  return { at, project: project.project, stage: project.stage, fails, warns, findings };
}
