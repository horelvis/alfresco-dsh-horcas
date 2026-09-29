/**
 * DOCUMENTO DE MIGRACION: informe en markdown generado desde el estado durable del proyecto (checkpoints,
 * hops, evidencia, journal, experiencia). No consulta sistemas vivos: es reproducible y sin secretos.
 * Incluye los tiempos REALES medidos por paso frente a la estimacion, base para calcular la ventana de PROD.
 */
import { stackForVersion } from './final-stack.js';
import type { ProjectConfig } from './project-config.js';
import type { Checkpoint } from './checkpoints.js';
import type { HopProgress } from './hops.js';
import type { JournalEntry } from './journal.js';
import type { ExperienceRecord } from './experience.js';
import type { ChecklistItem } from './checklist.js';
import type { Estimation, Phase } from './estimator.js';
import type { Hop } from './upgrade-paths.js';
import type { AuditResult } from './audit.js';

export interface ReportData {
  project: ProjectConfig;
  hops: Hop[];
  progress: HopProgress[];
  checkpoints: Checkpoint[];
  checklist: ChecklistItem[];
  journal: JournalEntry[];
  experience?: ExperienceRecord;
  estimate?: Estimation;
  /** Auditoria determinista (Nivel 0): si trae FAIL, el informe NO se declara validado. */
  audit?: AuditResult;
  generatedAt: string;
}

/** Fase del estimador a la que corresponde cada paso (para comparar estimado vs real). */
export const STEP_PHASE: Record<string, Phase> = {
  'backup-source-db': 'PRE_STAGING',
  'copy-content': 'PRE_STAGING',
  'restore-target-db': 'PRE_STAGING',
  'preflight-target': 'PRE_STAGING',
  'provision-hop': 'CUTOVER',
  'schema-upgrade': 'CUTOVER',
  'smoke-boot': 'CUTOVER',
  reindex: 'POST_CUTOVER',
  'verify-target': 'POST_CUTOVER',
};

const isDryRun = (c: Checkpoint): boolean => (c.detail ?? '').startsWith('dry-run');

/** Runs con ejecucion real (al menos un paso no dry-run), en orden cronologico. */
export function executedRuns(checkpoints: Checkpoint[]): Array<{ runId: string; steps: Checkpoint[] }> {
  const runs = new Map<string, Checkpoint[]>();
  for (const c of checkpoints) runs.set(c.runId, [...(runs.get(c.runId) ?? []), c]);
  return [...runs.entries()]
    .filter(([, steps]) => steps.some((s) => !isDryRun(s) && s.status !== 'SKIPPED'))
    .map(([runId, steps]) => ({ runId, steps }))
    .sort((a, b) => (a.steps[0]?.at ?? '').localeCompare(b.steps[0]?.at ?? ''));
}

/** Minutos REALES por fase: suma de la duracion del ultimo intento OK de cada paso por run. */
export function measuredPhaseMinutes(checkpoints: Checkpoint[]): Record<Phase, number> {
  const totals: Record<Phase, number> = { ASSESSMENT: 0, PRE_STAGING: 0, CUTOVER: 0, POST_CUTOVER: 0 };
  for (const run of executedRuns(checkpoints)) {
    const lastOk = new Map<string, Checkpoint>();
    for (const s of run.steps) if (s.status === 'OK' && !isDryRun(s)) lastOk.set(s.step, s);
    for (const s of lastOk.values()) {
      const phase = STEP_PHASE[s.step];
      if (phase) totals[phase] += (s.durationMs ?? 0) / 60_000;
    }
  }
  return totals;
}

/**
 * URL real de acceso a la UI de Share en el stack final. Con proxy comparte origen con el repositorio
 * (/share/); SIN proxy, Share publica su propio puerto (8081). Se usa para anotarlo en el informe.
 */
export function shareAccessUrl(p: ProjectConfig): string | undefined {
  const t = p.target;
  const stack = stackForVersion(t, t.version);
  if (!stack?.share || !t.baseUrl) return undefined;
  try {
    const url = new URL(t.baseUrl);
    if (!stack.proxy) url.port = '8081';
    return `${url.origin}/share/`;
  } catch {
    return undefined;
  }
}

const cell = (value: string, max = 90): string => {
  const flat = value.replace(/\s+/g, ' ').replace(/\|/g, '\\|').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};
const minutes = (value: number): string => (value < 1 ? `${Math.round(value * 60)} s` : `${value.toFixed(1)} min`);
const day = (iso?: string): string => (iso ? iso.replace('T', ' ').slice(0, 16) : '—');

export function renderMigrationReport(d: ReportData): string {
  const p = d.project;
  const s = p.source;
  const t = p.target;
  const out: string[] = [];
  const counts = { OK: 0, WARN: 0, FAIL: 0, PENDING: 0 };
  for (const i of d.checklist) counts[i.status]++;
  const lastHop = d.hops.at(-1)?.to;
  const done = new Set(d.progress.map((h) => h.to));
  const finalReached = d.hops.length <= 1 ? d.checkpoints.some((c) => c.step === 'smoke-boot' && c.status === 'OK') : !!lastHop && done.has(lastHop);
  const lastSmoke = [...d.checkpoints].reverse().find((c) => c.step === 'smoke-boot' && c.status === 'OK');
  const blockers = d.journal.filter((j) => j.kind === 'blocker');
  const open = d.checklist.filter((i) => i.status !== 'OK');

  out.push(`# Informe de migracion — ${p.project}`);
  out.push('');
  out.push(`ACS ${s.edition ?? 'CE'} ${s.version} → ${t.edition ?? 'CE'} ${t.version} · stage **${p.stage.toUpperCase()}** · generado ${day(d.generatedAt)} (UTC) por alfresco-migrator`);
  out.push('');

  out.push('## 1. Resumen ejecutivo');
  out.push('');
  const auditFails = d.audit?.fails ?? 0;
  out.push(`- **Estado**: ${finalReached ? `ruta completada; DESTINO en la version final (${lastSmoke?.detail ?? t.version})` : `en curso (${d.progress.length}/${d.hops.length} hops)`}${auditFails > 0 ? ` · **AUDITORIA: ${auditFails} FAIL (NO validado)**` : ''}.`);
  out.push(`- **Checklist**: ${counts.OK} OK · ${counts.WARN} WARN · ${counts.PENDING} PENDING · ${counts.FAIL} FAIL (de ${d.checklist.length}).`);
  if (d.experience) {
    const ok = d.experience.attempts.filter((a) => a.outcome === 'ok').length;
    const validated = d.experience.validated && auditFails === 0;
    out.push(
      `- **Ensayo**: ${d.experience.attempts.length} intentos registrados (${ok} OK); validado=${validated ? 'si' : 'no'}` +
        (d.audit ? `; auditoria: ${d.audit.fails} FAIL / ${d.audit.warns} WARN` : '') +
        '.',
    );
  }
  out.push(`- **Pendiente antes de PROD**: ${open.length === 0 ? 'nada' : open.map((i) => `${i.text} (${i.status})`).join('; ')}.`);
  out.push('');

  out.push('## 2. Alcance y entorno');
  out.push('');
  out.push('| | Origen | Destino |');
  out.push('|---|---|---|');
  out.push(`| Version | ${s.edition ?? 'CE'} ${s.version} | ${t.edition ?? 'CE'} ${t.version} |`);
  out.push(`| Base de datos | ${s.database?.engine ?? '—'} ${s.database?.name ?? ''} | ${t.database?.engine ?? '—'} ${t.database?.name ?? ''} |`);
  out.push(`| Content store | ${cell(s.contentStore?.path ?? '—')} | ${cell(t.contentStore?.path ?? '—')} |`);
  out.push(`| Busqueda | ${s.search?.engine ?? '—'} | ${t.search?.engine ?? '—'} |`);
  out.push(`| Despliegue | — | ${t.deployment ?? '—'}${t.dataDir ? ` en ${t.dataDir}` : ''} |`);
  out.push('');
  out.push(`Estrategia: contenido **${p.migration.contentStrategy ?? '—'}**, BD **${p.migration.dbStrategy ?? '—'}**, indice **${p.migration.indexStrategy ?? '—'}**; politica de coherencia **${p.migration.coherencePolicy ?? 'FAIL_ON_DANGLING'}**. El ORIGEN es inmutable (solo lectura).`);
  const share = shareAccessUrl(p);
  if (share) {
    out.push(
      `Stack final: repositorio en ${t.baseUrl ?? '—'} · Share en ${share}` +
        `${stackForVersion(t, t.version)?.proxy ? ' (tras proxy, mismo origen)' : ' (SIN proxy: Share publica su propio puerto 8081)'}.`,
    );
  }
  out.push('');

  out.push('## 3. Ruta de upgrade');
  out.push('');
  out.push('| Hop | Clase | Completado |');
  out.push('|---|---|---|');
  for (const h of d.hops) {
    const progress = d.progress.filter((x) => x.to === h.to).at(-1);
    out.push(`| ${h.from} → ${h.to} | ${h.pathClass} | ${progress ? day(progress.at) : d.hops.length <= 1 && finalReached ? day(lastSmoke?.at) : 'pendiente'} |`);
  }
  out.push('');

  out.push('## 4. Ejecucion');
  out.push('');
  for (const run of executedRuns(d.checkpoints)) {
    out.push(`### Run \`${run.runId}\` (${day(run.steps[0]?.at)})`);
    out.push('');
    out.push('| Paso | Estado | Duracion | Detalle |');
    out.push('|---|---|---|---|');
    for (const st of run.steps) {
      out.push(`| ${st.step} | ${st.status} | ${minutes((st.durationMs ?? 0) / 60_000)} | ${cell(st.detail ?? '')} |`);
    }
    out.push('');
  }

  out.push('## 5. Tiempos: estimado vs real (base para la ventana de PROD)');
  out.push('');
  const measured = measuredPhaseMinutes(d.checkpoints);
  out.push('| Fase | Estimado | Real (ensayo) |');
  out.push('|---|---|---|');
  for (const phase of ['PRE_STAGING', 'CUTOVER', 'POST_CUTOVER'] as Phase[]) {
    const est = d.estimate?.phases.find((x) => x.phase === phase);
    out.push(`| ${phase} | ${est ? minutes(est.minutes) : '—'} | ${minutes(measured[phase])} |`);
  }
  out.push('');
  out.push(
    d.estimate
      ? `Ventana de corte estimada: **${minutes(d.estimate.cutoverMinutes)}** (confianza ${d.estimate.confidence}, cuello ${d.estimate.bottleneck}). Los tiempos reales del ensayo recalibran el modelo: extrapolar a PROD por volumen (nodos/bytes) y re-ejecutar migrator_estimate con el throughput medido.`
      : 'Sin estimacion en este informe (el origen no estaba accesible al generarlo): ejecutar migrator_estimate.',
  );
  out.push('');

  const plan = d.estimate?.reindexPlan;
  out.push('### Politica de reindex para PROD');
  out.push('');
  if (plan) {
    out.push(`**${plan.policy}** (${plan.family}): ${plan.rationale}. Metadatos ~${plan.metadataHours.toFixed(1)} h, contenido ~${plan.contentHours.toFixed(1)} h (supuestos: medir con un piloto).`);
    out.push('');
    for (const step of plan.steps) out.push(`- ${step}`);
  } else {
    out.push('Sin politica calculada (ejecutar migrator_estimate con cutoverWindowHours).');
  }
  out.push('');

  out.push('## 6. Verificacion (checklist con evidencia)');
  out.push('');
  out.push('| Fase | Comprobacion | Estado | Evidencia |');
  out.push('|---|---|---|---|');
  for (const i of d.checklist) out.push(`| ${i.phase} | ${cell(i.text, 70)} | **${i.status}** | ${cell(i.detail, 110)} |`);
  out.push('');

  out.push('## 7. Decisiones, bloqueos y aprobaciones');
  out.push('');
  const milestones = d.journal.filter((j) => ['decision', 'blocker', 'approval', 'plan', 'strategy'].includes(j.kind));
  if (milestones.length === 0) out.push('Sin hitos registrados en el journal.');
  for (const j of milestones) out.push(`- ${day(j.at)} · **${j.kind}** — ${cell(j.summary, 400)}`);
  out.push('');

  out.push('## 8. Rollback');
  out.push('');
  out.push('- El ORIGEN no se modifica en ningun paso: el rollback es volver a apuntar los clientes al origen.');
  const backup = d.checklist.find((i) => i.key === 'backup-store');
  out.push(`- Backup no destructivo del origen: ${backup && backup.status === 'OK' ? backup.detail : 'no registrado (ejecutar migrator_backup)'}.`);
  out.push('');

  out.push('## 9. Pendiente y riesgos para PROD');
  out.push('');
  if (open.length === 0 && blockers.length === 0) out.push('Sin pendientes: el ensayo cumple el checklist.');
  for (const i of open) out.push(`- **${i.status}** · ${i.text}: ${cell(i.detail, 300)}`);
  for (const b of blockers.slice(-5)) out.push(`- **Bloqueo registrado** (${day(b.at)}): ${cell(b.summary, 300)}`);
  out.push('');

  out.push('## 10. Auditoria (determinista, contra el estado durable)');
  out.push('');
  if (!d.audit) {
    out.push('No ejecutada: el informe no se declara validado. Ejecutar `migrator_audit`.');
  } else if (d.audit.findings.length === 0) {
    out.push('Sin hallazgos: el ensayo cuadra con el estado durable.');
  } else {
    out.push(`Resultado: **${d.audit.fails} FAIL / ${d.audit.warns} WARN**. Verificado ${day(d.audit.at)}.`);
    for (const f of d.audit.findings) out.push(`- **${f.severity}** · \`${f.code}\`: ${cell(f.detail, 300)}`);
  }
  out.push('');
  return out.join('\n');
}
