/**
 * Tools de ESCRITURA del migrador. Actuan SOLO sobre el DESTINO y requieren aprobacion humana
 * (la politica `tools/pre-execute` las marca `ask`; el guard bloquea cualquier intento sobre el origen).
 *
 * `migrator_target`: resuelve y valida el plan (dry-run) y, con `execute`, provisiona el DESTINO
 * (Compose por hop, respetando `MIGRATOR_DST_PROVISION`). La ejecucion del pipeline de pasos vive en
 * `migrator_run_steps`.
 */
import type { Context } from '@deepseek-ai/cordis';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { loadProject } from '../domain/project-config.js';
import { requireDistinctTarget } from '../domain/guards.js';
import { requireSupportedUpgradePath, upgradePathWarnings } from '../domain/upgrade-paths.js';
import { loadSchemaReference } from '../domain/schema-reference.js';
import { dataDir } from '../domain/data-dir.js';
import { compareFingerprints, hasBlockingDrift, latestRehearsal, stateDir } from '../domain/experience.js';
import { gatherSourceFingerprint } from '../domain/fingerprint.js';
import { destinationRunning, projectToComposeRequest, provisionCompose, shouldSkipProvision } from '../domain/provision.js';
import type { HostRef } from '../infra/exec.js';

const text = (value: string) => [{ type: 'text' as const, text: value }];
const json = <T>(value: T): never => JSON.parse(JSON.stringify(value)) as never;

function destinationHost(project: Awaited<ReturnType<typeof loadProject>>): HostRef {
  if (project.access.mode === 'local' || Object.keys(project.access.hosts).length === 0) return { name: 'local' };
  const name = process.env.MIGRATOR_DST_HOST ?? 'dst-app';
  const host = project.access.hosts[name];
  return host ? { name, host: host.host, user: host.user, keyFile: host.keyFile } : { name: 'local' };
}

export function registerWriteTools(ctx: Context): void {
  ctx.tools.register(
    defineTool({
      name: 'migrator_target',
      description:
        'Prepara el DESTINO para la migracion. Solo DESTINO (nunca el origen). Con execute=false valida y devuelve el plan (dry-run); con execute=true provisiona el Compose por hop (respetando MIGRATOR_DST_PROVISION).',
      parameters: {
        project: { type: 'string', required: true, description: 'Ruta del YAML de proyecto' },
        execute: { type: 'boolean', description: 'true = provisiona el destino (requiere aprobacion); por defecto false' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            project: { type: 'string' },
            hops: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  from: { type: 'string' },
                  to: { type: 'string' },
                  pathClass: { type: 'string' },
                },
              },
            },
            referenceVersion: { type: 'string' },
            executed: { type: 'boolean' },
            provisioned: { type: 'boolean' },
            files: { type: 'array', items: { type: 'string' } },
            warnings: { type: 'array', items: { type: 'string' } },
            note: { type: 'string' },
          },
        },
        render: (_args, value) => {
          const v = value as {
            project: string;
            hops: Array<{ from: string; to: string; pathClass: string }>;
            referenceVersion: string;
            provisioned: boolean;
            files: string[];
            warnings: string[];
            note: string;
          };
          const hops = v.hops.map((h) => `  ${h.from} -> ${h.to} [${h.pathClass}]`).join('\n');
          const files = v.files.length ? `\n${v.files.map((f) => `- ${f}`).join('\n')}` : '';
          const warns = (v.warnings ?? []).map((w) => `AVISO: ${w}`).join('\n');
          return text(
            `Proyecto ${v.project} · referencia esquema ${v.referenceVersion} · provisionado=${v.provisioned}` +
              `${v.note ? ` · ${v.note}` : ''}\n${hops}${files}${warns ? `\n${warns}` : ''}`,
          );
        },
      },
      async execute(args) {
        const config = await loadProject(args.project);
        const hops = requireSupportedUpgradePath(config.source.version, config.target.version);
        const warnings = upgradePathWarnings(hops);
        const reference = await loadSchemaReference(config.source.version, dataDir());
        const planned = hops.map((h) => ({ from: h.from, to: h.to, pathClass: h.pathClass }));

        if (args.execute !== true) {
          return json({
            project: config.project,
            hops: planned,
            referenceVersion: reference.version,
            executed: false,
            provisioned: false,
            files: [] as string[],
            warnings,
            note: 'dry-run',
          });
        }

        requireDistinctTarget(config);
        if (config.stage === 'prod') {
          const rehearsal = await latestRehearsal(stateDir(), config.project);
          if (!rehearsal || !rehearsal.validated) {
            throw new Error('PROD exige una migracion de prueba validada (clone/TEST) registrada antes de ejecutar');
          }
          const current = await gatherSourceFingerprint(config.source.version, dataDir());
          const drift = compareFingerprints(rehearsal.fingerprint, current);
          if (hasBlockingDrift(drift)) {
            const blockers = drift.filter((d) => d.severity === 'BLOCKER').map((d) => `${d.kind}: ${d.detail}`);
            throw new Error('PROD bloqueado por drift respecto al ensayo: ' + blockers.join('; '));
          }
        }

        const mode = process.env.MIGRATOR_DST_PROVISION ?? 'auto';
        const host = destinationHost(config);
        const running = await destinationRunning(host);
        if (shouldSkipProvision(mode, running)) {
          return json({
            project: config.project,
            hops: planned,
            referenceVersion: reference.version,
            executed: false,
            provisioned: false,
            files: [] as string[],
            warnings,
            note: `provision omitida (modo ${mode}${running ? ', destino ya en ejecucion' : ''})`,
          });
        }
        const workDir = `${stateDir()}/provision`;
        const files: string[] = [];
        for (const hop of hops) {
          const result = await provisionCompose(projectToComposeRequest(config, hop.to), workDir, host);
          files.push(result.file);
        }
        return json({
          project: config.project,
          hops: planned,
          referenceVersion: reference.version,
          executed: true,
          provisioned: true,
          files,
          warnings,
          note: '',
        });
      },
    }),
  );
}
