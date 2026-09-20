import { describe, expect, it } from 'vitest';
import { computeAlfrescoMemory, memLimitForCompose, type MemoryData } from '../src/domain/memory.js';

const GIB = 1024 ** 3;
const data: MemoryData = { reservedGiB: 5, alfrescoShare: 0.5, minGiB: 2.5, maxGiB: 12, jvmMinPercent: 50, jvmMaxPercent: 75 };

describe('memoria de Alfresco segun RAM disponible', () => {
  it('16 GiB disponibles -> 5.5 GiB de limite', () => {
    const memory = computeAlfrescoMemory(16 * GIB, data);
    expect(memory.memLimitBytes).toBe(Math.round(5.5 * GIB));
    expect(memory.javaOpts).toContain('MaxRAMPercentage=75');
  });

  it('aplica el suelo (min 2.5 GiB) en hosts pequenos', () => {
    expect(memLimitForCompose(computeAlfrescoMemory(4 * GIB, data))).toBe('2560m');
  });

  it('aplica el techo (max 12 GiB) en hosts grandes', () => {
    expect(computeAlfrescoMemory(64 * GIB, data).memLimitBytes).toBe(12 * GIB);
  });

  it('mas RAM disponible => mas memoria (monotono)', () => {
    expect(computeAlfrescoMemory(32 * GIB, data).memLimitBytes).toBeGreaterThan(
      computeAlfrescoMemory(16 * GIB, data).memLimitBytes,
    );
  });
});
