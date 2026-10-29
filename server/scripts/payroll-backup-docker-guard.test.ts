import { describe, expect, it, vi } from 'vitest';
import { verifyPayrollBackupDockerTarget } from '../../scripts/test-payroll-backup-real-db.mjs';

const manifest = { id: 'a'.repeat(64), owner: 'attendance20261029', host: '127.0.0.1', port: 59021,
  image: `sha256:${'b'.repeat(64)}`, createdAt: '2026-10-29T00:00:00Z', hostDataMounts: false };
const url = 'postgresql://synthetic:synthetic@127.0.0.1:59021/payroll_test_guard';
const actual = { ...manifest, purpose: 'isolated-verification', running: true,
  networks: { bridge: { IPAddress: '172.17.0.2' } }, ports: { '5432/tcp': [{ HostIp: '127.0.0.1', HostPort: '59021' }] },
  mounts: [{ Type: 'tmpfs' }], tmpfs: { '/var/lib/postgresql/data': 'rw,noexec,nosuid' } };

describe('owned Docker test database guard', () => {
  it('accepts exactly the inspected fixture IP without querying or outputting container secrets', () => {
    const inspect = vi.fn(() => ({ status: 0, stdout: JSON.stringify(actual) }));
    expect(verifyPayrollBackupDockerTarget(url, manifest, inspect)).toEqual(['172.17.0.2']);
    expect(inspect.mock.calls[0][1]).toEqual(['inspect', '--format', expect.not.stringContaining('Config.Env'), manifest.id]);
    expect(inspect.mock.calls[0][2]).toMatchObject({ windowsHide: true, timeout: 10000 });
  });

  it.each([
    { id: 'c'.repeat(64) }, { owner: 'another-task' }, { image: `sha256:${'d'.repeat(64)}` },
    { purpose: 'production' }, { createdAt: '2020-01-01' }, { running: false },
    { ports: { '5432/tcp': [{ HostIp: '0.0.0.0', HostPort: '59021' }] } },
    { ports: { '5432/tcp': [{ HostIp: '127.0.0.1', HostPort: '5432' }] } },
    { mounts: [{ Type: 'bind', Source: 'C:/real-data' }] }, { tmpfs: {} },
    { networks: {} }, { networks: { bridge: { IPAddress: 'not-an-address' } } },
  ])('rejects a mismatched or persistent fixture %#', changed => {
    expect(() => verifyPayrollBackupDockerTarget(url, manifest, () => ({ status: 0, stdout: JSON.stringify({ ...actual, ...changed }) }))).toThrow();
  });

  it('rejects arbitrary manifests, wrong ports, unavailable Docker and malformed inspection', () => {
    for (const invalid of [undefined, {}, { ...manifest, owner: 'other' }, { ...manifest, id: 'short' }, { ...manifest, hostDataMounts: true }]) {
      expect(() => verifyPayrollBackupDockerTarget(url, invalid)).toThrow();
    }
    expect(() => verifyPayrollBackupDockerTarget(url.replace('59021', '5432'), manifest)).toThrow();
    expect(() => verifyPayrollBackupDockerTarget(url, manifest, () => ({ status: 1, stdout: '' }))).toThrow();
    expect(() => verifyPayrollBackupDockerTarget(url, manifest, () => ({ status: 0, stdout: 'invalid' }))).toThrow();
  });
});
