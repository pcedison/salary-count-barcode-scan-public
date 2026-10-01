import { afterEach, describe, expect, it, vi } from 'vitest';
import { createJsonTestServer, jsonRequest } from '../test-utils/http-test-server';
import { setupTestAdminSession, TEST_ADMIN_HEADER } from '../test-utils/admin-test-session';
import { payrollWritePause } from './payrollWritePause';
vi.mock('../storage', () => ({ storage: {} }));

afterEach(() => vi.unstubAllEnvs());
describe('compatible rollback HTTP guard', () => {
  it('blocks old handlers and correction/import/automation writers, retaining reads and authentication', async () => {
    vi.stubEnv('PAYROLL_WRITES_PAUSED', 'true');
    const legacyWriter = vi.fn();
    const server = await createJsonTestServer(app => {
      app.use(payrollWritePause);
      app.all('*', (_req, res) => { legacyWriter(); res.json({ success: true }); });
    }, { setupApp: setupTestAdminSession });
    try {
      for (const [method, path] of [
        ['POST', '/api/salary-records'], ['PATCH', '/api/salary-records/101'],
        ['DELETE', '/api/salary-records/101'], ['POST', '/api/admin/import/salary-record'],
        ['POST', '/api/salary-records/101/holiday-corrections'],
        ['POST', '/api/salary-automation/run'], ['DELETE', '/api/employees/101/purge'],
        ['POST', '/API/SALARY-RECORDS/'], ['POST', '/api/admin/import/salary-record/'],
        ['POST', '/API/SALARY-AUTOMATION/RUN'],
      ]) {
        const result = await jsonRequest<{code: string}>(server.baseUrl, path, {
          method, headers: { [TEST_ADMIN_HEADER]: 'true', 'Content-Type': 'application/json' }, body: '{}',
        });
        expect(result.response.status, path).toBe(503);
        expect(result.body?.code).toBe('PAYROLL_WRITES_PAUSED');
      }
      expect(legacyWriter).not.toHaveBeenCalled();
      expect((await jsonRequest(server.baseUrl, '/api/salary-records/101', { method: 'PATCH' })).response.status).toBe(401);
      expect((await jsonRequest(server.baseUrl, '/api/salary-records/101')).response.status).toBe(200);
      expect((await jsonRequest(server.baseUrl, '/api/verify-admin', { method: 'POST' })).response.status).toBe(200);
      expect((await jsonRequest(server.baseUrl, '/api/salary-records/101/holiday-corrections/preview', { method: 'POST' })).response.status).toBe(200);
      expect(legacyWriter).toHaveBeenCalledTimes(3);
    } finally { await server.close(); }
  });
});
