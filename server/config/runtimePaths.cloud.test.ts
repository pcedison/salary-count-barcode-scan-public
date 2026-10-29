import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertCloudRuntimeStorage } from './runtimePaths';

afterEach(() => vi.unstubAllEnvs());
function fixture() {
  const root = path.join(os.tmpdir(), 'synthetic-gcs-volume');
  vi.stubEnv('APP_DEPLOYMENT_MODE', 'cloudrun'); vi.stubEnv('APP_AUDIT_SINK', 'stdout');
  vi.stubEnv('APP_STORAGE_MOUNT', root); vi.stubEnv('APP_STORAGE_BUCKET', 'synthetic-bucket');
  vi.stubEnv('APP_RUNTIME_DIR', path.join(root, 'runtime')); vi.stubEnv('APP_BACKUP_DIR', path.join(root, 'backups'));
  return { root, mountInfo: `10 2 0:20 / ${root} rw,relatime - fuse.gcsfuse gcsfuse rw\n`,
    metadata: { format: 'attendance-runtime-v1', bucket: 'synthetic-bucket' }, realPath: (value: string) => value };
}
describe('Cloud Run persistent mount evidence', () => {
  it('requires kernel mount evidence and matching operator bucket metadata', () => {
    const evidence = fixture(); expect(() => assertCloudRuntimeStorage(evidence)).not.toThrow();
    for (const mountInfo of ['', evidence.mountInfo.replace('fuse.gcsfuse', 'overlay'), evidence.mountInfo.replace(' rw,', ' ro,')]) {
      expect(() => assertCloudRuntimeStorage({ ...evidence, mountInfo })).toThrow(/could not be verified/);
    }
    expect(() => assertCloudRuntimeStorage({ ...evidence, metadata: { ...evidence.metadata, bucket: 'other-bucket' } })).toThrow(/could not be verified/);
  });
  it('rejects paths escaping the mount through lexical paths or symlinks', () => {
    const evidence = fixture(); vi.stubEnv('APP_BACKUP_DIR', path.join(os.tmpdir(), 'outside'));
    expect(() => assertCloudRuntimeStorage(evidence)).toThrow(/could not be verified/);
    vi.stubEnv('APP_BACKUP_DIR', path.join(evidence.root, 'backups'));
    expect(() => assertCloudRuntimeStorage({ ...evidence, realPath: value => value.endsWith('backups') ? path.join(os.tmpdir(), 'outside') : value })).toThrow(/could not be verified/);
  });
  it('fails closed without explicit paths, stdout audit, or real runtime evidence', () => {
    const evidence = fixture(); vi.stubEnv('APP_AUDIT_SINK', 'file');
    expect(() => assertCloudRuntimeStorage(evidence)).toThrow(/APP_AUDIT_SINK/);
    vi.stubEnv('APP_AUDIT_SINK', 'stdout'); vi.stubEnv('APP_RUNTIME_DIR', undefined);
    expect(() => assertCloudRuntimeStorage(evidence)).toThrow(/explicit absolute/);
    fixture(); expect(() => assertCloudRuntimeStorage()).toThrow(/could not be verified/);
  });
  it('keeps the existing local path behavior without external mount requirements', () => {
    vi.stubEnv('APP_DEPLOYMENT_MODE', 'local'); expect(() => assertCloudRuntimeStorage()).not.toThrow();
  });
});
