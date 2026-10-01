import { afterEach, describe, expect, it, vi } from 'vitest';
import { payrollWritePause } from './middleware/payrollWritePause';
import { setupAdminSession, createAdminSession } from './session';
import { createJsonTestServer, jsonRequest } from './test-utils/http-test-server';
import { PermissionLevel } from './admin-auth';
import { registerSalaryRoutes } from './routes/salary.routes';
import { registerImportRoutes } from './routes/import.routes';
import { registerEmployeeRoutes } from './routes/employees.routes';
import { registerSalaryAutomationRoutes } from './routes/salaryAutomation.routes';
import { registerDashboardRoutes } from './dashboard-routes';
import { salaryRepository } from './repositories/salaryRepository';

vi.mock('./db', () => ({ db: {} }));
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('maintenance actual legacy HTTP handlers', () => {
  it('guards canonical, case and trailing slash writes while preserving authenticated reads', async () => {
    vi.stubEnv('PAYROLL_WRITES_PAUSED', 'true');
    const read = vi.spyOn(salaryRepository, 'getSalaryRecordById').mockResolvedValue({ id: 1, netSalary: 31000 } as any);
    const write = vi.spyOn(salaryRepository, 'updateSalaryRecord');
    const server = await createJsonTestServer(app => {
      app.post('/test-login', async (req, res) => { await createAdminSession(req, PermissionLevel.SUPER); res.json({ success: true }); });
      app.post('/test-admin-login', async (req, res) => { await createAdminSession(req, PermissionLevel.ADMIN); res.json({ success: true }); });
      app.use(payrollWritePause);
      registerSalaryRoutes(app);
      registerImportRoutes(app);
      registerEmployeeRoutes(app);
      registerSalaryAutomationRoutes(app);
      registerDashboardRoutes(app);
    }, { setupApp: app => setupAdminSession(app) });
    try {
      const login = await jsonRequest(server.baseUrl, '/test-login', { method: 'POST' });
      const cookie = login.response.headers.get('set-cookie')!.split(';')[0];
      const paths: [string, string][] = [
        ['POST', '/api/salary-records'], ['PATCH', '/api/salary-records/1'], ['DELETE', '/api/salary-records/1'],
        ['POST', '/api/admin/import/salary-record'], ['POST', '/api/salary-automation/run'],
        ['DELETE', '/api/employees/1/purge'], ['POST', '/api/dashboard/backups'],
        ['POST', '/api/dashboard/backups/missing/restore'], ['DELETE', '/api/dashboard/backups/missing'],
      ];
      for (const [method, path] of paths) {
        for (const variant of [path, `${path}/`, `${path.toUpperCase()}/`]) {
          const response = await jsonRequest<{ code: string }>(server.baseUrl, variant, {
            method, headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: '{}',
          });
          expect(response.response.status, `${method} ${variant}`).toBe(503);
          expect(response.body?.code).toBe(path.includes('/dashboard/backups') ? 'MAINTENANCE_BACKUP_READ_ONLY' : 'PAYROLL_WRITES_PAUSED');
          expect(response.response.headers.get('cache-control')).toBe('no-store');
        }
      }
      const protectedWrite = await jsonRequest(server.baseUrl, '/api/salary-records/1', { method: 'PATCH' });
      expect(protectedWrite.response.status).toBe(401);
      const response = await jsonRequest<{ netSalary: number }>(server.baseUrl, '/api/salary-records/1', { headers: { Cookie: cookie } });
      expect(response.response.status).toBe(200);
      expect(response.body?.netSalary).toBe(31000);
      expect(read).toHaveBeenCalledOnce();
      expect(write).not.toHaveBeenCalled();
      const adminLogin = await jsonRequest(server.baseUrl, '/test-admin-login', { method: 'POST' });
      const adminCookie = adminLogin.response.headers.get('set-cookie')!.split(';')[0];
      for (const [method, path] of paths.filter(([, path]) => path.includes('/dashboard/backups') || path.includes('/purge'))) {
        const adminWrite = await jsonRequest(server.baseUrl, path.toUpperCase()+'/', { method, headers: { Cookie: adminCookie } });
        expect(adminWrite.response.status).toBe(403);
      }
    } finally { await server.close(); }
  });
});
