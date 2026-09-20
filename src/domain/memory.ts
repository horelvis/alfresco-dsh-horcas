/**
 * Reparto de memoria del stack de destino.
 *
 * El limite de memoria del repositorio Alfresco NO es una constante: se calcula a partir de la RAM
 * disponible en el host/Docker (`docker info .MemTotal`) con los factores de `data/memory.yaml`
 * (reserva para el resto de servicios, fraccion para Alfresco, suelo y techo). El JVM usa porcentajes
 * del limite del contenedor, de modo que se adapta si cambia la RAM.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { dataDir } from './data-dir.js';

const GiB = 1024 ** 3;

export interface AlfrescoMemory {
  /** Limite del contenedor Alfresco en bytes. */
  memLimitBytes: number;
  /** Opciones JVM derivadas (porcentajes sobre el limite). */
  javaOpts: string;
  /** Heap maximo resultante en bytes (informativo). */
  xmxBytes: number;
}

export interface MemoryData {
  reservedGiB: number;
  alfrescoShare: number;
  minGiB: number;
  maxGiB: number;
  jvmMinPercent: number;
  jvmMaxPercent: number;
}

const DEFAULTS: MemoryData = {
  reservedGiB: 5,
  alfrescoShare: 0.5,
  minGiB: 2.5,
  maxGiB: 12,
  jvmMinPercent: 50,
  jvmMaxPercent: 75,
};

let cached: MemoryData | undefined;

export function memoryData(): MemoryData {
  if (cached) return cached;
  try {
    const parsed = yaml.load(readFileSync(path.join(dataDir(), 'memory.yaml'), 'utf8')) as Partial<MemoryData>;
    cached = { ...DEFAULTS, ...parsed };
  } catch {
    cached = { ...DEFAULTS };
  }
  return cached;
}

/** Recarga los factores (tests o cambios en caliente). */
export function reloadMemory(): void {
  cached = undefined;
}

const clamp = (value: number, low: number, high: number): number => Math.min(Math.max(value, low), high);

/** Calcula el limite y las opciones JVM del repositorio a partir de la RAM disponible. */
export function computeAlfrescoMemory(
  availableRamBytes: number,
  data: MemoryData = memoryData(),
): AlfrescoMemory {
  const usable = Math.max(0, availableRamBytes - data.reservedGiB * GiB);
  const target = usable * data.alfrescoShare;
  const memLimitBytes = Math.round(clamp(target, data.minGiB * GiB, data.maxGiB * GiB));
  const xmxBytes = Math.round((memLimitBytes * data.jvmMaxPercent) / 100);
  return {
    memLimitBytes,
    javaOpts: `-XX:MinRAMPercentage=${data.jvmMinPercent} -XX:MaxRAMPercentage=${data.jvmMaxPercent}`,
    xmxBytes,
  };
}

/** Valor de `mem_limit` de Docker Compose (`<n>m`). */
export function memLimitForCompose(memory: AlfrescoMemory): string {
  return `${Math.round(memory.memLimitBytes / (1024 * 1024))}m`;
}
