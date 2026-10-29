import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createJsonTestServer, jsonRequest } from '../test-utils/http-test-server';

const executeMock = vi.hoisted(() => vi.fn(async (): Promise<Record<string, unknown>[]> => [{ '?column?': 1 }]));

vi.mock('../db', () => ({
  db: {
    execute: executeMock
  }
}));

let registerHealthRoutes: typeof import('./health.routes').registerHealthRoutes;
let resetHealthCacheForTest: typeof import('./health.routes').resetHealthCacheForTest;

beforeAll(async () => {
  ({ registerHealthRoutes, resetHealthCacheForTest } = await import('./health.routes'));
});

beforeEach(() => {
  executeMock.mockReset();
  executeMock.mockResolvedValue([{ '?column?': 1 }]);
  resetHealthCacheForTest();
});
afterEach(() => vi.unstubAllEnvs());

describe('health routes integration', () => {
  it('Cloud Run requires pre-created session and secured clock receipt schemas without DDL', async () => {
    vi.stubEnv('APP_DEPLOYMENT_MODE', 'cloudrun'); vi.stubEnv('NODE_ENV', 'production');
    const server = await createJsonTestServer(registerHealthRoutes);
    try {
      executeMock.mockImplementation(async sql => String(sql).includes('obj_description') ? [{ secured: true, marker: 'barcode-scan:line-clock-requests:v1' }] : []);
      expect((await jsonRequest(server.baseUrl, '/ready')).response.status).toBe(200);
      expect(executeMock.mock.calls.every(call => String(call[0]).startsWith('SELECT'))).toBe(true);
      executeMock.mockImplementation(async sql => { if (String(sql).includes('user_sessions')) throw new Error('private database metadata'); return []; });
      const missing = await jsonRequest<Record<string, any>>(server.baseUrl, '/ready');
      expect(missing.response.status).toBe(503); expect(JSON.stringify(missing.body)).not.toContain('private');
      executeMock.mockResolvedValue([{ secured: false, marker: 'barcode-scan:line-clock-requests:v1' }]);
      expect((await jsonRequest(server.baseUrl, '/ready')).response.status).toBe(503);
      expect((await jsonRequest(server.baseUrl, '/live')).response.status).toBe(200);
    } finally { await server.close(); }
  });
  it('returns healthy status and probe payloads when the database is available', async () => {
    const server = await createJsonTestServer(registerHealthRoutes);

    try {
      const health = await jsonRequest<Record<string, any>>(server.baseUrl, '/api/health');
      expect(health.response.status).toBe(200);
      expect(health.response.headers.get('cache-control')).toBe('no-store');
      expect(health.body).toMatchObject({
        status: 'healthy',
        checks: {
          database: {
            status: 'pass'
          },
          memory: {
            status: 'pass'
          }
        }
      });

      const ready = await jsonRequest<Record<string, any>>(server.baseUrl, '/ready');
      expect(ready.response.status).toBe(200);
      expect(ready.response.headers.get('cache-control')).toBe('no-store');
      expect(ready.body).toMatchObject({
        ready: true,
        checks: {
          database: {
            status: 'pass'
          }
        }
      });

      const live = await jsonRequest<Record<string, any>>(server.baseUrl, '/live');
      expect(live.response.status).toBe(200);
      expect(live.response.headers.get('cache-control')).toBe('no-store');
      expect(live.body).toMatchObject({
        alive: true
      });
    } finally {
      await server.close();
    }
  });

  it('returns degraded health and not-ready status when the database check fails', async () => {
    executeMock.mockRejectedValueOnce(new Error('db offline'));
    executeMock.mockRejectedValueOnce(new Error('db offline'));

    const server = await createJsonTestServer(registerHealthRoutes);

    try {
      const health = await jsonRequest<Record<string, any>>(server.baseUrl, '/api/health');
      expect(health.response.status).toBe(503);
      expect(health.body).toMatchObject({
        status: 'degraded',
        checks: {
          database: {
            status: 'fail',
            message: 'db offline'
          }
        }
      });

      const ready = await jsonRequest<Record<string, any>>(server.baseUrl, '/ready');
      expect(ready.response.status).toBe(503);
      expect(ready.body).toMatchObject({
        ready: false,
        checks: {
          database: {
            status: 'fail',
            message: 'db offline'
          }
        }
      });
    } finally {
      await server.close();
    }
  });
});
