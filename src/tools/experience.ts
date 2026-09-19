/**
 * Tools del flujo ENSAYO -> PRODUCCION.
 *
 * - `migrator_rehearsal_record`: guarda la experiencia de una migracion de prueba (clone/TEST).
 * - `migrator_experience_latest`: consulta el ultimo ensayo registrado.
 * - `migrator_environment_parity`: compara el origen actual (p.ej. PROD) con el ensayo y detecta drift.
 */
import type { Context } from '@deepseek-ai/cordis';
import { defineTool } from '@deepseek-ai/dsh-tools';
import {
  compareFingerprints,
  hasBlockingDrift,
  latestRehearsal,
  loadExperiences,
  recordExperience,
  stateDir,
  type ExperienceRecord,
  type Stage,
} from '../domain/experience.js';
import { fingerprintValidated, gatherSourceFingerprint } from '../domain/fingerprint.js';
import { dataDir } from '../domain/data-dir.js';

const text = (value: string) => [{ type: 'text' as const, text: value }];

const recordSchema = {
  type: 'object' as const,
  additionalProperties: true,
  properties: {
    id: { type: 'string' as const },
    stage: { type: 'string' as const },
    project: { type: 'string' as const },
    validated: { type: 'boolean' as const },
    sourceVersion: { type: 'string' as const },
    targetVersion: { type: 'string' as const },
  },
};

function newId(project: string, stage: string): string {
  return `${project}-${stage}-${Date.now()}`;
}

export function registerExperienceTools(ctx: Context): void {
  ctx.tools.register(
    defineTool({
      name: 'migrator_rehearsal_record',
      description:
        'Registra la experiencia de una migracion de PRUEBA (clone/TEST): fingerprint del origen (esquema, replicacion, inventario) para reutilizarla en PROD.',
      parameters: {
        project: { type: 'string', required: true },
        version: { type: 'string', required: true, description: 'Version ACS del origen ensayado' },
        targetVersion: { type: 'string', required: true },
        stage: { type: 'string', enum: ['clone', 'test', 'prod'], description: 'clone o test (por defecto test)' },
        notes: { type: 'string' },
      },
      output: {
        schema: recordSchema,
        render: (_args, value) => {
          const r = value as ExperienceRecord;
          return text(`Ensayo ${r.id} stage=${r.stage} validado=${r.validated}\n${JSON.stringify(r.fingerprint)}`);
        },
      },
      async execute(args) {
        const stage = (args.stage ?? 'test') as Stage;
        const fingerprint = await gatherSourceFingerprint(args.version, dataDir());
        const record: ExperienceRecord = {
          id: newId(args.project, stage),
          createdAt: new Date().toISOString(),
          project: args.project,
          stage,
          sourceVersion: args.version,
          targetVersion: args.targetVersion,
          validated: fingerprintValidated(fingerprint),
          fingerprint,
          steps: [],
          findings: [],
          notes: args.notes,
        };
        await recordExperience(stateDir(), record);
        return { ...record, fingerprint: { ...record.fingerprint } };
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'migrator_experience_latest',
      description: 'Devuelve el ultimo ensayo registrado del proyecto (opcionalmente filtrado por stage).',
      parameters: {
        project: { type: 'string', required: true },
        stage: { type: 'string', enum: ['clone', 'test', 'prod'] },
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => text(value ? JSON.stringify(value, null, 2) : 'Sin experiencia registrada'),
      },
      async execute(args) {
        const records = await loadExperiences(stateDir(), args.project);
        const filtered = args.stage ? records.filter((r) => r.stage === args.stage) : records;
        const latest = filtered.sort((a, b) => a.createdAt.localeCompare(b.createdAt)).at(-1);
        return latest ? { found: true, ...JSON.parse(JSON.stringify(latest)) } : { found: false };
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'migrator_environment_parity',
      description:
        'Compara el origen actual con el ultimo ensayo validado y devuelve el drift (BLOCKER impide ejecutar en PROD).',
      parameters: {
        project: { type: 'string', required: true },
        version: { type: 'string', required: true, description: 'Version ACS del origen actual' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: {
            hasRehearsal: { type: 'boolean' },
            rehearsalId: { type: 'string' },
            blocking: { type: 'boolean' },
            drift: { type: 'array', items: { type: 'object', additionalProperties: true } },
          },
        },
        render: (_args, value) => {
          const v = value as { hasRehearsal: boolean; rehearsalId?: string; blocking: boolean; drift: Array<{ kind: string; severity: string; detail: string }> };
          if (!v.hasRehearsal) return text('Sin ensayo validado: PROD no debe ejecutarse.');
          const lines = v.drift.map((d) => `- [${d.severity}] ${d.kind}: ${d.detail}`);
          return text(`Ensayo ${v.rehearsalId} · blocking=${v.blocking}\n${lines.join('\n') || '(sin drift)'}`);
        },
      },
      async execute(args) {
        const rehearsal = await latestRehearsal(stateDir(), args.project);
        if (!rehearsal) {
          return { hasRehearsal: false, rehearsalId: '', blocking: true, drift: [] };
        }
        const current = await gatherSourceFingerprint(args.version, dataDir());
        const drift = compareFingerprints(rehearsal.fingerprint, current);
        return {
          hasRehearsal: true,
          rehearsalId: rehearsal.id,
          blocking: hasBlockingDrift(drift),
          drift: drift.map((d) => ({ ...d })),
        };
      },
    }),
  );
}
