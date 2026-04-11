import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { isKnownSelfSignedPoolerHostMock } = vi.hoisted(() => ({
  isKnownSelfSignedPoolerHostMock: vi.fn((databaseUrl: string) =>
    databaseUrl.includes('allow-pooler.example.test')
  )
}));

vi.mock('./databaseUrl', () => ({
  isKnownSelfSignedPoolerHost: isKnownSelfSignedPoolerHostMock
}));

import { validateEnv } from './envValidator';

const ORIGINAL_ENV = { ...process.env };

function buildEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    ...ORIGINAL_ENV,
    NODE_ENV: 'test',
    DATABASE_URL: 'postgresql://user:pass@db.internal.test:5432/app',
    SESSION_TIMEOUT: undefined,
    SESSION_SECRET: undefined,
    SESSION_SECURE: undefined,
    SESSION_SAME_SITE: undefined,
    PGSSLREJECT_UNAUTHORIZED: undefined,
    SUPER_ADMIN_PIN: undefined,
    ENCRYPTION_KEY: undefined,
    BACKUP_ENCRYPTION_KEY: undefined,
    SCAN_DEVICE_TOKEN: undefined,
    USE_AES_ENCRYPTION: undefined,
    APP_RUNTIME_DIR: undefined,
    APP_BACKUP_DIR: undefined,
    APP_LOG_DIR: undefined,
    ALLOW_DOTENV_IN_PRODUCTION: undefined,
    ENCRYPTION_SALT: undefined,
    LINE_LOGIN_CHANNEL_ID: undefined,
    LINE_LOGIN_CHANNEL_SECRET: undefined,
    LINE_LOGIN_CALLBACK_URL: undefined,
    LINE_MESSAGING_CHANNEL_ACCESS_TOKEN: undefined,
    LINE_MESSAGING_CHANNEL_SECRET: undefined,
    ...overrides
  };
}

describe('validateEnv', () => {
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.restoreAllMocks();
  });

  it('allows test defaults without session or encryption secrets', () => {
    process.env = buildEnv();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const validated = validateEnv();

    expect(validated.NODE_ENV).toBe('test');
    expect(warnSpy).toHaveBeenCalledTimes(3);
  });

  it('rejects AES write mode when ENCRYPTION_KEY is missing', () => {
    process.env = buildEnv({
      USE_AES_ENCRYPTION: 'true'
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(() => validateEnv()).toThrow(
      'USE_AES_ENCRYPTION=true requires an ENCRYPTION_KEY with at least 32 characters'
    );
  });

  it('rejects insecure SameSite=None session cookies', () => {
    process.env = buildEnv({
      SESSION_SAME_SITE: 'none',
      SESSION_SECURE: 'false'
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(() => validateEnv()).toThrow(
      'SESSION_SAME_SITE=none requires SESSION_SECURE=true'
    );
  });

  it('requires SESSION_SECRET in production', () => {
    process.env = buildEnv({
      NODE_ENV: 'production',
      SESSION_SECURE: 'true'
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(() => validateEnv()).toThrow(
      'SESSION_SECRET is required in production and must be at least 32 characters'
    );
  });

  it('requires backup encryption in production', () => {
    process.env = buildEnv({
      NODE_ENV: 'production',
      SESSION_SECRET: 'production-session-secret-123456789012',
      SESSION_SECURE: 'true'
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(() => validateEnv()).toThrow(
      'Production backups require BACKUP_ENCRYPTION_KEY or ENCRYPTION_KEY'
    );
  });

  it('rejects PGSSLREJECT_UNAUTHORIZED=false in production for unknown hosts', () => {
    process.env = buildEnv({
      NODE_ENV: 'production',
      DATABASE_URL: 'postgresql://user:pass@db.internal.test:5432/app',
      SESSION_SECRET: 'production-session-secret-123456789012',
      SESSION_SECURE: 'true',
      PGSSLREJECT_UNAUTHORIZED: 'false'
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(() => validateEnv()).toThrow(
      'PGSSLREJECT_UNAUTHORIZED=false is only allowed in production for known self-signed pooler hosts'
    );
  });

  it('accepts PGSSLREJECT_UNAUTHORIZED=false in production for known self-signed pooler hosts', () => {
    process.env = buildEnv({
      NODE_ENV: 'production',
      DATABASE_URL:
        'postgresql://user:pass@allow-pooler.example.test:6543/postgres',
      SESSION_SECRET: 'production-session-secret-123456789012',
      SESSION_SECURE: 'true',
      BACKUP_ENCRYPTION_KEY: 'backup-encryption-secret-1234567890',
      PGSSLREJECT_UNAUTHORIZED: 'false'
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const validated = validateEnv();

    expect(validated.NODE_ENV).toBe('production');
    expect(warnSpy).toHaveBeenCalled();
  });

  it('rejects SESSION_SECURE=false in production even when the rest of the config is valid', () => {
    process.env = buildEnv({
      NODE_ENV: 'production',
      SESSION_SECRET: 'production-session-secret-123456789012',
      SESSION_SECURE: 'false'
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(() => validateEnv()).toThrow('SESSION_SECURE must be set to true in production');
  });

  it('rejects plaintext SUPER_ADMIN_PIN in production', () => {
    process.env = buildEnv({
      NODE_ENV: 'production',
      SESSION_SECRET: 'production-session-secret-123456789012',
      SESSION_SECURE: 'true',
      BACKUP_ENCRYPTION_KEY: 'backup-encryption-secret-1234567890',
      SUPER_ADMIN_PIN: '654321'
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(() => validateEnv()).toThrow('SUPER_ADMIN_PIN must be hashed in production');
  });

  it('accepts hashed SUPER_ADMIN_PIN in production', () => {
    process.env = buildEnv({
      NODE_ENV: 'production',
      SESSION_SECRET: 'production-session-secret-123456789012',
      SESSION_SECURE: 'true',
      SUPER_ADMIN_PIN: 'abc123:600000:0123456789abcdef',
      BACKUP_ENCRYPTION_KEY: 'backup-encryption-secret-1234567890'
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const validated = validateEnv();

    expect(validated.NODE_ENV).toBe('production');
  });

  it('accepts production backups protected by ENCRYPTION_KEY alone', () => {
    process.env = buildEnv({
      NODE_ENV: 'production',
      SESSION_SECRET: 'production-session-secret-123456789012',
      SESSION_SECURE: 'true',
      ENCRYPTION_KEY: 'shared-encryption-key-123456789012'
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const validated = validateEnv();

    expect(validated.ENCRYPTION_KEY).toBe('shared-encryption-key-123456789012');
  });

  it('rejects production backup paths that still resolve inside the workspace', () => {
    process.env = buildEnv({
      NODE_ENV: 'production',
      SESSION_SECRET: 'production-session-secret-123456789012',
      SESSION_SECURE: 'true',
      BACKUP_ENCRYPTION_KEY: 'backup-encryption-secret-1234567890',
      APP_BACKUP_DIR: path.join(process.cwd(), 'backups-runtime')
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(() => validateEnv()).toThrow(
      'APP_BACKUP_DIR must resolve outside the workspace in production'
    );
  });

  it('rejects production audit log paths that still resolve inside the workspace', () => {
    process.env = buildEnv({
      NODE_ENV: 'production',
      SESSION_SECRET: 'production-session-secret-123456789012',
      SESSION_SECURE: 'true',
      BACKUP_ENCRYPTION_KEY: 'backup-encryption-secret-1234567890',
      APP_LOG_DIR: path.join(process.cwd(), 'logs-runtime')
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(() => validateEnv()).toThrow(
      'APP_LOG_DIR must resolve outside the workspace in production'
    );
  });

  it('accepts production runtime paths outside the workspace', () => {
    process.env = buildEnv({
      NODE_ENV: 'production',
      SESSION_SECRET: 'production-session-secret-123456789012',
      SESSION_SECURE: 'true',
      BACKUP_ENCRYPTION_KEY: 'backup-encryption-secret-1234567890',
      APP_RUNTIME_DIR: path.join(os.tmpdir(), 'barcode-scan-runtime')
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const validated = validateEnv();

    expect(validated.NODE_ENV).toBe('production');
    expect(validated.APP_RUNTIME_DIR).toContain('barcode-scan-runtime');
  });
});
