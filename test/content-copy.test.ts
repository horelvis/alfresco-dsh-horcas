import { describe, expect, it } from 'vitest';
import { planContentCopy } from '../src/domain/content-copy.js';

describe('content copy planner', () => {
  it('FS -> FS usa rsync con stats', () => {
    const plan = planContentCopy({ type: 'FS', path: '/src' }, { type: 'FS', path: '/dst' });
    expect(plan.via).toBe('RSYNC');
    expect(plan.command).toContain('rsync -a');
    expect(plan.command).toContain('/src/');
    expect(plan.command).toContain('/dst/');
  });

  it('delta anade --delete y bwlimit', () => {
    const plan = planContentCopy({ type: 'FS', path: '/src' }, { type: 'FS', path: '/dst' }, { delta: true, bandwidthKbps: 20000 });
    expect(plan.command).toContain('--delete');
    expect(plan.command).toContain('--bwlimit=20000');
  });

  it('FS -> FS remoto usa sshTarget con identidad', () => {
    const plan = planContentCopy({ type: 'FS', path: '/src' }, { type: 'FS', path: '/dst' }, { sshTarget: 'user@host', sshIdentity: '/k' });
    expect(plan.command).toContain('user@host:/dst/');
    expect(plan.command).toContain('-i /k');
  });

  it('FS -> S3 usa aws s3 sync', () => {
    const plan = planContentCopy({ type: 'FS', path: '/src' }, { type: 'S3', bucket: 'bucket/prefix' });
    expect(plan.via).toBe('S3');
    expect(plan.command).toContain('aws s3 sync');
    expect(plan.command).toContain('s3://bucket/prefix');
  });

  it('S3 -> FS y delta con --delete', () => {
    const plan = planContentCopy({ type: 'S3', bucket: 'b' }, { type: 'FS', path: '/dst' }, { delta: true });
    expect(plan.command).toContain('aws s3 sync s3://b "/dst" --delete');
  });

  it('Azure usa azcopy --recursive', () => {
    const plan = planContentCopy({ type: 'FS', path: '/src' }, { type: 'AZURE', bucket: 'https://acct.blob.core.windows.net/c' });
    expect(plan.via).toBe('AZURE');
    expect(plan.command).toContain('azcopy copy');
    expect(plan.command).toContain('--recursive');
  });

  it('S3 sin bucket falla', () => {
    expect(() => planContentCopy({ type: 'FS', path: '/src' }, { type: 'S3' })).toThrow();
  });

  it('FS sin path falla', () => {
    expect(() => planContentCopy({ type: 'FS' }, { type: 'FS', path: '/dst' })).toThrow();
  });
});
