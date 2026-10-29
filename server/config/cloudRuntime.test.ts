import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mountCheck = vi.hoisted(() => vi.fn());
vi.mock('./runtimePaths', async importOriginal => ({ ...await importOriginal<typeof import('./runtimePaths')>(), assertCloudRuntimeStorage: mountCheck }));
import { validateEnv } from './envValidator';
import { areBackgroundServicesEnabled } from './runtimeMode';

beforeEach(() => {
  vi.stubEnv('NODE_ENV', 'production'); vi.stubEnv('DATABASE_URL', 'postgres://synthetic:synthetic@localhost/isolated');
  vi.stubEnv('SESSION_SECRET', 'synthetic-session-configuration-only-0000'); vi.stubEnv('SESSION_SECURE', 'true');
  vi.stubEnv('BACKUP_ENCRYPTION_KEY', 'synthetic-backup-configuration-only-00000');
  for (const key of ['LINE_LOGIN_CHANNEL_ID','LINE_LOGIN_CHANNEL_SECRET','LINE_LOGIN_CALLBACK_URL','LINE_MESSAGING_CHANNEL_ACCESS_TOKEN','LINE_MESSAGING_CHANNEL_SECRET','PGSSLREJECT_UNAUTHORIZED','SUPER_ADMIN_PIN','APP_RUNTIME_DIR','APP_BACKUP_DIR','APP_LOG_DIR']) vi.stubEnv(key, undefined);
  vi.stubEnv('APP_DEPLOYMENT_MODE', 'cloudrun'); vi.stubEnv('APP_BACKGROUND_SERVICES', 'disabled'); vi.stubEnv('SALARY_AUTOMATION_ENABLED', 'false');
  vi.stubEnv('APP_PUBLIC_ORIGIN', 'https://attendance.example.test'); vi.stubEnv('ALLOWED_ORIGINS', 'https://attendance.example.test');
  vi.stubEnv('SALARY_AUTOMATION_PUBLIC_BASE_URL', 'https://attendance.example.test');
  mountCheck.mockReset(); vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });
describe('Cloud Run execution policy', () => {
  it('validates explicit cloud settings and consults verified storage before serving', () => {
    expect(validateEnv().APP_DEPLOYMENT_MODE).toBe('cloudrun'); expect(mountCheck).toHaveBeenCalledOnce();
    mountCheck.mockImplementation(() => { throw new Error('unverified mount'); }); expect(() => validateEnv()).toThrow('unverified mount');
  });
  it.each(['enabled', undefined])('rejects non-disabled background service value %s', value => {
    vi.stubEnv('APP_BACKGROUND_SERVICES', value); expect(() => validateEnv()).toThrow(/worker ownership/);
    expect(areBackgroundServicesEnabled()).toBe(false);
  });
  it('rejects legacy standby URL overrides and unverified database TLS', () => {
    vi.stubEnv('ALLOWED_ORIGINS', 'https://old-standby.example.test'); expect(() => validateEnv()).toThrow(/must match/);
    vi.stubEnv('ALLOWED_ORIGINS', 'https://attendance.example.test'); vi.stubEnv('LINE_LOGIN_CALLBACK_URL', 'https://old-standby.example.test/api/line/callback');
    expect(() => validateEnv()).toThrow(/callback/);
    vi.stubEnv('LINE_LOGIN_CALLBACK_URL', undefined); vi.stubEnv('PGSSLREJECT_UNAUTHORIZED', 'false'); expect(() => validateEnv()).toThrow(/certificate validation/);
  });
  it('rejects Cloud Run falling back to local ephemeral defaults', () => {
    vi.stubEnv('K_SERVICE', 'synthetic-service'); vi.stubEnv('APP_DEPLOYMENT_MODE', 'local'); expect(() => validateEnv()).toThrow(/ephemeral defaults/);
  });
});
