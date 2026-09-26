/**
 * ESTADO REAL del DESTINO en solo lectura, para que el agente no improvise por shell (la guarda bloquea
 * `docker run` y demas mutaciones): contenedores del proyecto, directorio de version (composes, config,
 * JAR de modelos), ficheros del content store y presencia de datos en pg-data. Las carpetas de datos son
 * de otros uid (Alfresco 33000, Postgres 999): se inspeccionan con un contenedor efimero montado `:ro`.
 */
export interface TargetState {
  containers: Array<{ name: string; status: string; image: string }>;
  dataDir?: string;
  dataDirExists: boolean;
  composes: string[];
  modelsJar: boolean;
  alfDataFiles?: number;
  pgData: 'present' | 'empty' | 'absent' | 'unknown';
}

const MARK = '@@';

/** Comando unico (solo lectura) que emite secciones `@@clave` parseables. */
export function targetStateCommand(project: string, dataDir?: string): string {
  const parts = [
    `echo "${MARK}containers"`,
    `docker ps -a --filter "label=com.docker.compose.project=${project}" --format "{{.Names}}|{{.Status}}|{{.Image}}"`,
  ];
  if (dataDir) {
    parts.push(
      `echo "${MARK}datadir"`,
      `test -d "${dataDir}" && echo yes || echo no`,
      `echo "${MARK}composes"`,
      `ls "${dataDir}/compose" 2>/dev/null`,
      `echo "${MARK}models"`,
      `ls "${dataDir}/models" 2>/dev/null`,
      // Contenedor efimero con el directorio montado SOLO LECTURA (los datos son de otros uid).
      `echo "${MARK}volume"`,
      `test -d "${dataDir}" && docker run --rm -v "${dataDir}:/mnt:ro" alpine sh -c 'echo "alf=$(find /mnt/alf-data -type f 2>/dev/null | wc -l)"; if [ -d /mnt/pg-data ]; then echo "pg=$(ls -A /mnt/pg-data 2>/dev/null | wc -l)"; else echo "pg=absent"; fi' 2>/dev/null`,
    );
  }
  return parts.join('; ');
}

export function parseTargetState(stdout: string, dataDir?: string): TargetState {
  const sections = new Map<string, string[]>();
  let current = '';
  for (const raw of stdout.split('\n')) {
    const line = raw.trim();
    if (line.startsWith(MARK)) {
      current = line.slice(MARK.length);
      sections.set(current, []);
    } else if (line && current) {
      sections.get(current)!.push(line);
    }
  }
  const containers = (sections.get('containers') ?? []).map((l) => {
    const [name = '', status = '', image = ''] = l.split('|');
    return { name, status, image };
  });
  const volume = Object.fromEntries((sections.get('volume') ?? []).map((l) => l.split('=') as [string, string]));
  const alf = Number.parseInt(volume.alf ?? '', 10);
  const pgRaw = volume.pg;
  const pgData: TargetState['pgData'] =
    pgRaw === undefined ? 'unknown' : pgRaw === 'absent' ? 'absent' : Number.parseInt(pgRaw, 10) > 0 ? 'present' : 'empty';
  return {
    containers,
    ...(dataDir ? { dataDir } : {}),
    dataDirExists: (sections.get('datadir') ?? [])[0] === 'yes',
    composes: sections.get('composes') ?? [],
    modelsJar: (sections.get('models') ?? []).some((f) => f.endsWith('-models.jar')),
    ...(Number.isFinite(alf) ? { alfDataFiles: alf } : {}),
    pgData,
  };
}

export function describeTargetState(s: TargetState): string {
  const running = s.containers.filter((c) => c.status.startsWith('Up'));
  return [
    `contenedores del proyecto: ${s.containers.length} (${running.length} en marcha)${s.containers.length ? ` — ${s.containers.map((c) => `${c.name}: ${c.status}`).join('; ')}` : ''}`,
    `directorio de version ${s.dataDir ?? '(sin target.dataDir)'}: ${s.dataDirExists ? 'existe' : 'no existe'}`,
    `composes: ${s.composes.join(', ') || '—'} · JAR de modelos: ${s.modelsJar ? 'si' : 'no'}`,
    `content store: ${s.alfDataFiles ?? '?'} ficheros · pg-data: ${s.pgData}`,
  ].join('\n');
}
