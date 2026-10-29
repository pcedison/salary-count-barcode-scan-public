import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildPrimaryService } from '../../deploy/cloudrun-primary.mjs';

const config = () => JSON.parse(readFileSync(new URL('../../deploy/cloudrun-primary.example.json', import.meta.url), 'utf8'));
describe('primary manifest dry generation', () => {
  it('keeps always-on CPU, fixed origin, mounted storage and disabled workers', () => {
    const input = config(); const result = buildPrimaryService(input);
    expect(result.metadata.labels['attendance-role']).toBe('primary');
    const template = result.spec.template;
    expect(template.metadata.annotations).toMatchObject({ 'autoscaling.knative.dev/minScale': '1', 'run.googleapis.com/cpu-throttling': 'false' });
    const container = template.spec.containers[0];
    const env = Object.fromEntries(container.env.map((value: any) => [value.name, value.value ?? value.valueFrom]));
    expect(env.APP_BACKGROUND_SERVICES).toBe('disabled'); expect(env.SALARY_AUTOMATION_ENABLED).toBe('false');
    expect(env.ALLOWED_ORIGINS).toBe(input.origin); expect(env.LINE_LOGIN_CALLBACK_URL).toBe(`${input.origin}/api/line/callback`);
    expect(env.DATABASE_URL).toEqual({ secretKeyRef: { name: 'attendance-database', key: '1' } });
    expect(template.spec.volumes[0].csi.driver).toBe('gcsfuse.run.googleapis.com');
    expect(container.volumeMounts[0].mountPath).toBe(env.APP_STORAGE_MOUNT);
  });
  it('rejects dangerous overrides, mutable images, raw secrets and standby targets', () => {
    for (const extra of [{ service: 'salary-scan-standby' }, { image: 'node:latest' }, { origin: 'http://attendance.test' }, { origin: 'https://attendance.test/path' }, { liffId: '' }, { extraEnv: { APP_BACKGROUND_SERVICES: 'enabled' } }]) {
      expect(() => buildPrimaryService({ ...config(), ...extra })).toThrow();
    }
    const unsafe = config(); unsafe.secrets.DATABASE_URL = 'postgres://private-secret'; expect(() => buildPrimaryService(unsafe)).toThrow();
    const latest = config(); latest.secrets.DATABASE_URL.version = 'latest'; expect(() => buildPrimaryService(latest)).toThrow();
  });
  it('requires explicit preservation of the existing identity encryption mode and secrets', () => {
    const missingMode = config(); delete missingMode.useAesEncryption;
    expect(() => buildPrimaryService(missingMode)).toThrow('useAesEncryption');
    for (const name of ['ENCRYPTION_KEY', 'ENCRYPTION_SALT']) {
      const missingSecret = config(); delete missingSecret.secrets[name];
      expect(() => buildPrimaryService(missingSecret)).toThrow('existing encryption key and salt');
    }
    for (const mode of [true, false]) {
      const input = config(); input.useAesEncryption = mode;
      const env = buildPrimaryService(input).spec.template.spec.containers[0].env;
      expect(env.find((entry: any) => entry.name === 'USE_AES_ENCRYPTION').value).toBe(String(mode));
      expect(env.find((entry: any) => entry.name === 'ENCRYPTION_KEY').valueFrom.secretKeyRef.name).toBe('attendance-existing-identity-key');
    }
  });
  it('legacy mutation entrypoints perform the primary-role guard before changes', () => {
    const common = readFileSync(new URL('../../deploy/lib/cloudrun-common.sh', import.meta.url), 'utf8');
    expect(common).toContain('attendance-role'); expect(common).toContain('Unable to verify legacy Cloud Run target; refusing changes');
    for (const filename of ['cloudrun-env.sh', 'deploy-all.sh']) {
      const source = readFileSync(new URL(`../../deploy/${filename}`, import.meta.url), 'utf8');
      expect(source.indexOf('assert_legacy_cloud_run_target || fail')).toBeGreaterThan(0);
      expect(source.indexOf('assert_legacy_cloud_run_target || fail')).toBeLessThan(source.indexOf('gcloud run deploy'));
    }
  });
});
