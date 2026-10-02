import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PermissionLevel } from '../admin-auth';
import { setupAdminSession } from '../session';
import { createJsonTestServer, jsonRequest } from '../test-utils/http-test-server';

const backups = vi.hoisted(() => ({
  BackupType: { DAILY: 'daily', WEEKLY: 'weekly', MONTHLY: 'monthly', MANUAL: 'manual' },
  getBackupsList: vi.fn(() => []), getConnectionHistory: vi.fn(() => []),
  checkDatabaseConnection: vi.fn(async () => ({ currentStorage: 'postgres' })),
  createDatabaseBackup: vi.fn(), deleteBackup: vi.fn(),
  getRestorePreflight: vi.fn(), restoreFromBackup: vi.fn(),
  validateBackupId: vi.fn((value: string) => value),
}));
const storage = vi.hoisted(() => ({ getCalculationRules: vi.fn(async () => []) }));
const repository = vi.hoisted(() => ({
  getAllSalaryRecordsPage: vi.fn(async () => ({ rows: [], total: 0 })),
  commitSalaryCorrection: vi.fn(),
}));
vi.mock('../db-monitoring', () => backups);
vi.mock('../storage', () => ({ storage }));
vi.mock('../repositories/salaryRepository', () => ({ salaryRepository: repository }));
vi.mock('../services/calculationRulesLoader', () => ({ reloadCalculationRulesFromDb: vi.fn() }));

let register: (app: import('express').Express) => void;
beforeAll(async () => {
  const [{ registerDashboardRoutes }, { registerSalaryRoutes }, { registerCalculationRulesRoutes }] = await Promise.all([
    import('../dashboard-routes'), import('./salary.routes'), import('./calculationRules.routes'),
  ]);
  register = (app) => { registerDashboardRoutes(app); registerSalaryRoutes(app); registerCalculationRulesRoutes(app); };
});
beforeEach(() => vi.clearAllMocks());

async function testServer() {
  return createJsonTestServer(register, { setupApp: (app) => {
    setupAdminSession(app);
    app.use((req, _res, next) => {
      const role = req.get('x-synthetic-role');
      if (role === 'ADMIN' || role === 'SUPER') req.session.adminAuth = {
        isAdmin: true, permissionLevel: PermissionLevel[role], authenticatedAt: Date.now(), lastVerifiedAt: Date.now(),
      };
      next();
    });
  } });
}

const sensitiveRoutes = [
  ['GET', '/api/dashboard/backups'],
  ['POST', '/api/dashboard/backups'],
  ['GET', '/api/dashboard/backups/synthetic/restore-preview'],
  ['POST', '/api/dashboard/backups/synthetic/restore'],
  ['DELETE', '/api/dashboard/backups/synthetic'],
  ['GET', '/api/dashboard/operational-metrics'],
  ['GET', '/api/calculation-rules'],
  ['POST', '/api/calculation-rules'],
  ['PUT', '/api/calculation-rules/1'],
  ['DELETE', '/api/calculation-rules/1'],
] as const;

describe('authorization matrix with real session and authorization middleware', () => {
  it.each(sensitiveRoutes)('rejects anonymous and ordinary ADMIN requests to %s %s', async (method, path) => {
    const server = await testServer();
    try {
      for (const role of ['', 'ADMIN']) {
        const result = await jsonRequest(server.baseUrl, path, {
          method, headers: { 'content-type': 'application/json', ...(role ? { 'x-synthetic-role': role } : {}) },
          ...(method !== 'GET' ? { body: '{}' } : {}),
        });
        expect(result.response.status).toBe(role ? 403 : 401);
      }
      expect(backups.getBackupsList).not.toHaveBeenCalled();
      expect(backups.getRestorePreflight).not.toHaveBeenCalled();
      expect(backups.createDatabaseBackup).not.toHaveBeenCalled();
      expect(backups.restoreFromBackup).not.toHaveBeenCalled();
      expect(backups.deleteBackup).not.toHaveBeenCalled();
      expect(storage.getCalculationRules).not.toHaveBeenCalled();
    } finally { await server.close(); }
  });

  it('permits SUPER backup/rule reads and ADMIN salary reads without elevating an ordinary session', async () => {
    const server = await testServer();
    try {
      for (const path of ['/api/dashboard/backups', '/api/calculation-rules']) {
        expect((await jsonRequest(server.baseUrl, path, { headers: { 'x-synthetic-role': 'SUPER' } })).response.status).toBe(200);
      }
      expect((await jsonRequest(server.baseUrl, '/api/salary-records', { headers: { 'x-synthetic-role': 'ADMIN' } })).response.status).toBe(200);
      expect(repository.getAllSalaryRecordsPage).toHaveBeenCalledOnce();
      expect(backups.getBackupsList).toHaveBeenCalledOnce();
      expect(storage.getCalculationRules).toHaveBeenCalledOnce();
    } finally { await server.close(); }
  });

  it.each([
    { 'content-type': 'application/json', origin: 'https://untrusted.example', status: 403 },
    { 'content-type': 'application/json', 'sec-fetch-site': 'cross-site', status: 403 },
    { 'content-type': 'text/plain', status: 415 },
  ])('rejects cross-origin/non-JSON payroll corrections before repository access: %j', async ({ status, ...headers }) => {
    const server = await testServer();
    try {
      const result = await jsonRequest(server.baseUrl, '/api/salary-records/7', {
        method: 'PATCH', headers: { ...headers, 'x-synthetic-role': 'ADMIN' }, body: '{}',
      });
      expect(result.response.status).toBe(status);
      expect(repository.commitSalaryCorrection).not.toHaveBeenCalled();
    } finally { await server.close(); }
  });
});
