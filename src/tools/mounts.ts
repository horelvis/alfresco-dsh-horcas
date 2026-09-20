/**
 * Tool de analisis de MONT AJES (NAS/SAN): clasifica origen/destino y detecta riesgos
 * (mismo backing store, doble salto por red). Read-only.
 */
import type { Context } from '@deepseek-ai/cordis';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { workspaceCwd } from '../infra/session.js';
import { loadProject } from '../domain/project-config.js';
import { assessMounts, parseLsblk, parseMounts } from '../domain/mounts.js';
import { runShell, type HostRef } from '../infra/exec.js';

const text = (value: string) => [{ type: 'text' as const, text: value }];
const json = <T>(value: T): never => JSON.parse(JSON.stringify(value)) as never;

function destinationHost(project: Awaited<ReturnType<typeof loadProject>>): HostRef {
  if (project.access.mode === 'local' || Object.keys(project.access.hosts).length === 0) return { name: 'local' };
  const name = process.env.MIGRATOR_DST_HOST ?? 'dst-app';
  const host = project.access.hosts[name];
  return host ? { name, host: host.host, user: host.user, keyFile: host.keyFile } : { name: 'local' };
}

async function readMounts(host: HostRef): Promise<string> {
  const result = await runShell(host, 'cat /proc/mounts 2>/dev/null || findmnt -rn -o SOURCE,TARGET,FSTYPE,OPTIONS');
  return result.stdout;
}

async function readLsblk(host: HostRef): Promise<string> {
  const result = await runShell(host, 'lsblk -dn -o NAME,TRAN,VENDOR,MODEL 2>/dev/null');
  return result.stdout;
}

export function registerMountTools(ctx: Context): void {
  ctx.tools.register(
    defineTool({
      name: 'migrator_mount_check',
      timeoutMs: 60_000,
      description:
        'Analiza los montajes del content store en origen y destino (NAS/SAN/NFS/CIFS): clasifica el tipo y detecta mismo backing store o doble salto por red. Read-only.',
      parameters: {
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: {
            sourceKind: { type: 'string' },
            targetKind: { type: 'string' },
            sourceDeviceKind: { type: 'string' },
            targetDeviceKind: { type: 'string' },
            blocking: { type: 'boolean' },
            requiresHumanConfirmation: { type: 'boolean' },
            findings: { type: 'array', items: { type: 'object', additionalProperties: true } },
          },
        },
        render: (_args, value) => {
          const v = value as {
            sourceKind: string;
            targetKind: string;
            sourceDevice?: { transport?: string; vendor?: string; model?: string };
            targetDevice?: { transport?: string; vendor?: string; model?: string };
            blocking: boolean;
            requiresHumanConfirmation: boolean;
            findings: Array<{ severity: string; detail: string }>;
          };
          const lines = v.findings.map((f) => `- [${f.severity}] ${f.detail}`).join('\n');
          const device = (d?: { transport?: string; vendor?: string; model?: string }): string =>
            d ? `${d.transport ?? '?'}/${d.vendor ?? '?'}/${d.model ?? '?'}` : '-';
          return text(
            `origen=${v.sourceKind} (${device(v.sourceDevice)}) destino=${v.targetKind} (${device(v.targetDevice)})` +
              ` bloqueante=${v.blocking} confirmacionHumana=${v.requiresHumanConfirmation}\n${lines || '(sin hallazgos)'}`,
          );
        },
      },
      async execute(args, exec) {
        const project = await loadProject(undefined, workspaceCwd(exec));
        const sourcePath = project.source.contentStore?.path ?? '';
        const targetPath = project.target.contentStore?.path ?? '';
        const host = destinationHost(project);
        // El origen puede estar en el host de operacion (local); el destino, en el remoto.
        const sourceMounts = parseMounts(await readMounts({ name: 'local' }));
        const sourceDevices = parseLsblk(await readLsblk({ name: 'local' }));
        const targetMounts = host.name === 'local' ? sourceMounts : parseMounts(await readMounts(host));
        const targetDevices = host.name === 'local' ? sourceDevices : parseLsblk(await readLsblk(host));
        const assessment = assessMounts(sourcePath, targetPath, sourceMounts, targetMounts, sourceDevices, targetDevices);
        return json(assessment);
      },
    }),
  );
}
