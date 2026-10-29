import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setupAdminSession } from './session';

const stores = vi.hoisted(() => [] as Array<Record<string, unknown>>);
vi.mock('./storage', () => ({ storage: {} }));
vi.mock('pg', () => ({ Pool: class { query = vi.fn(); } }));
vi.mock('connect-pg-simple', async () => {
  const { default: session } = await import('express-session');
  return { default: () => class extends session.Store {
    constructor(options: Record<string, unknown>) { super(); stores.push(options); }
  } };
});

beforeEach(() => {
  stores.length = 0;
  vi.stubEnv('NODE_ENV', 'production');
  vi.stubEnv('VITEST', 'false');
  vi.stubEnv('SESSION_SECRET', 'synthetic-session-secret-for-isolated-test-only');
  vi.stubEnv('DATABASE_URL', 'postgresql://unused:unused@127.0.0.1:9/unused');
  vi.stubEnv('APP_DEPLOYMENT_MODE', 'local');
  vi.stubEnv('APP_BACKGROUND_SERVICES', 'enabled');
});
afterEach(() => vi.unstubAllEnvs());

describe('Cloud Run session store safety', () => {
  it('does not run background cleanup or create tables on Cloud Run startup', () => {
    vi.stubEnv('APP_DEPLOYMENT_MODE', 'cloudrun');
    vi.stubEnv('APP_BACKGROUND_SERVICES', 'disabled');
    setupAdminSession(express());
    expect(stores).toHaveLength(1);
    expect(stores[0]).toMatchObject({ createTableIfMissing: false, pruneSessionInterval: false, tableName: 'user_sessions' });
  });

  it('preserves local automatic session-table initialization and default cleanup', () => {
    setupAdminSession(express());
    expect(stores[0]).toMatchObject({ createTableIfMissing: true, pruneSessionInterval: undefined });
  });

  it('also disables session cleanup for an explicitly disabled local background role', () => {
    vi.stubEnv('APP_BACKGROUND_SERVICES', 'disabled');
    setupAdminSession(express());
    expect(stores[0]).toMatchObject({ createTableIfMissing: true, pruneSessionInterval: false });
  });
});
