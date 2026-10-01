import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createJsonTestServer, jsonRequest } from './test-utils/http-test-server';
import { TEST_ADMIN_HEADER, setupTestAdminSession } from './test-utils/admin-test-session';

const checkDatabaseConnectionMock = vi.hoisted(() => vi.fn(async () => ({
  currentStorage: 'postgres',
  connections: {
    postgres: true,
    supabase: { isConnected: false, disabled: true }
  }
})));
const createDatabaseBackupMock = vi.hoisted(() => vi.fn(async () => 'backup-1'));
const restoreFromBackupMock = vi.hoisted(() => vi.fn(async () => ({ success: true })));
const getRestorePreflightMock = vi.hoisted(() => vi.fn(async () => ({
  requiresJournalConfirmation: true, replacedJournalRows: 1, confirmationToken: 'a'.repeat(64),
  payrollTotals: { delta: { grossSalary: 0, totalDeductions: 1000, netSalary: -1000 } },
})));
const deleteBackupMock = vi.hoisted(() => vi.fn(async () => true));
const getOperationalMetricsSummaryMock = vi.hoisted(() =>
  vi.fn(() => ({
    generatedAt: '2026-04-10T00:00:00.000Z',
    auth: { adminLoginFailures: { total: 0, lastHour: 0, last15Minutes: 0, last5Minutes: 0 } }
  }))
);
const validateBackupIdMock = vi.hoisted(() =>
  vi.fn((backupId: string) => {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(backupId)) {
      throw new Error('Backup id contains invalid path characters');
    }
    return backupId;
  })
);

vi.mock('./admin-auth', () => ({
  PermissionLevel: {
    SUPER: 4
  },
  logOperation: vi.fn(),
  OperationType: {
    BACKUP: 'backup',
    RESTORE: 'restore',
    SYSTEM_CONFIG: 'system_config',
    DELETE: 'delete'
  },
  getOperationLogs: vi.fn(async () => []),
  getAvailableLogDates: vi.fn(async () => [])
}));

vi.mock('./db-monitoring', () => ({
  checkDatabaseConnection: checkDatabaseConnectionMock,
  createDatabaseBackup: createDatabaseBackupMock,
  BackupType: {
    DAILY: 'daily',
    WEEKLY: 'weekly',
    MONTHLY: 'monthly',
    MANUAL: 'manual'
  },
  getBackupsList: vi.fn(() => []),
  restoreFromBackup: restoreFromBackupMock,
  getRestorePreflight: getRestorePreflightMock,
  deleteBackup: deleteBackupMock,
  getConnectionHistory: vi.fn(() => []),
  validateBackupId: validateBackupIdMock
}));

vi.mock('./observability/runtimeMetrics', () => ({
  recordCounter: vi.fn(),
  getOperationalMetricsSummary: getOperationalMetricsSummaryMock
}));

vi.mock('./middleware/requireAdmin', () => ({
  requireAdmin: () => (req: { session?: { adminAuth?: { isAdmin?: boolean } } }, res: any, next: () => void) => {
    if (!req.session?.adminAuth?.isAdmin) {
      return res.status(401).json({
        success: false,
        message: '缺少管理員授權，請重新登入管理員模式'
      });
    }

    next();
  }
}));

let registerDashboardRoutes: typeof import('./dashboard-routes').registerDashboardRoutes;

beforeAll(async () => {
  ({ registerDashboardRoutes } = await import('./dashboard-routes'));
});

beforeEach(() => {
  checkDatabaseConnectionMock.mockClear();
  createDatabaseBackupMock.mockClear();
  restoreFromBackupMock.mockClear();
  getRestorePreflightMock.mockClear();
  deleteBackupMock.mockClear();
  getOperationalMetricsSummaryMock.mockClear();
  validateBackupIdMock.mockClear();
  vi.clearAllMocks();
});

describe('dashboard routes integration', () => {
  it('previews payroll impact without creating a backup or restoring data', async () => {
    const server = await createJsonTestServer(registerDashboardRoutes, { setupApp: setupTestAdminSession });
    try {
      const result = await jsonRequest<Record<string, any>>(server.baseUrl,
        '/api/dashboard/backups/backup-1/restore-preview?type=manual', { headers: { [TEST_ADMIN_HEADER]: 'true' } });
      expect(result.response.status).toBe(200);
      expect(result.response.headers.get('cache-control')).toBe('no-store');
      expect(result.body?.data.payrollTotals.delta.netSalary).toBe(-1000);
      expect(getRestorePreflightMock).toHaveBeenCalledWith('backup-1', 'manual');
      expect(createDatabaseBackupMock).not.toHaveBeenCalled();
      expect(restoreFromBackupMock).not.toHaveBeenCalled();
    } finally { await server.close(); }
  });

  it.each([
    [{}, 400],
    [{ confirmRestore: true, confirmationToken: 'b'.repeat(64), confirmJournalReplacement: true }, 409],
    [{ confirmRestore: true, confirmationToken: 'a'.repeat(64) }, 409],
  ])('refuses unconfirmed or stale restore requests before side effects', async (body, status) => {
    const server = await createJsonTestServer(registerDashboardRoutes, { setupApp: setupTestAdminSession });
    try {
      const result = await jsonRequest(server.baseUrl, '/api/dashboard/backups/backup-1/restore', {
        method: 'POST', headers: { [TEST_ADMIN_HEADER]: 'true', 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      expect(result.response.status).toBe(status);
      expect(createDatabaseBackupMock).not.toHaveBeenCalled();
      expect(restoreFromBackupMock).not.toHaveBeenCalled();
    } finally { await server.close(); }
  });

  it('passes explicit confirmation into the locked restore and expires the current admin cookie', async () => {
    const server = await createJsonTestServer(registerDashboardRoutes, { setupApp: setupTestAdminSession });
    try {
      const result = await jsonRequest(server.baseUrl, '/api/dashboard/backups/backup-1/restore', {
        method: 'POST', headers: { [TEST_ADMIN_HEADER]: 'true', 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'manual', confirmRestore: true, confirmJournalReplacement: true, confirmationToken: 'a'.repeat(64) }),
      });
      expect(result.response.status).toBe(200);
      expect(createDatabaseBackupMock).toHaveBeenCalledTimes(1);
      expect(restoreFromBackupMock).toHaveBeenCalledWith('backup-1', 'manual', {
        skipPreRestoreBackup: true, confirmJournalReplacement: true, confirmationToken: 'a'.repeat(64),
      });
      expect(result.response.headers.get('set-cookie')).toContain('Expires=Thu, 01 Jan 1970');
    } finally { await server.close(); }
  });

  it('refuses cross-origin restores before reading the backup or creating safeguards', async () => {
    const server = await createJsonTestServer(registerDashboardRoutes, { setupApp: setupTestAdminSession });
    try {
      const result = await jsonRequest(server.baseUrl, '/api/dashboard/backups/backup-1/restore', {
        method: 'POST', headers: { [TEST_ADMIN_HEADER]: 'true', 'Content-Type': 'application/json', Origin: 'https://untrusted.invalid' }, body: '{}',
      });
      expect(result.response.status).toBe(403);
      expect(getRestorePreflightMock).not.toHaveBeenCalled();
      expect(createDatabaseBackupMock).not.toHaveBeenCalled();
    } finally { await server.close(); }
  });

  it('requires admin authorization for all dashboard operations routes', async () => {
    const server = await createJsonTestServer(registerDashboardRoutes, {
      setupApp: async (app) => {
        setupTestAdminSession(app);
      }
    });

    try {
      const endpoints = [
        { method: 'GET', path: '/api/dashboard/connection-history' },
        { method: 'POST', path: '/api/dashboard/backups', body: {} },
        { method: 'GET', path: '/api/dashboard/backups' },
        { method: 'GET', path: '/api/dashboard/backups/backup-1/restore-preview' },
        { method: 'POST', path: '/api/dashboard/backups/backup-1/restore', body: {} },
        { method: 'GET', path: '/api/dashboard/logs' },
        { method: 'GET', path: '/api/dashboard/logs/dates' },
        { method: 'GET', path: '/api/dashboard/operational-metrics' },
        { method: 'POST', path: '/api/dashboard/sync', body: {} },
        { method: 'GET', path: '/api/dashboard/consistency' },
        { method: 'DELETE', path: '/api/dashboard/backups/backup-1' },
        { method: 'GET', path: '/api/dashboard/connection' }
      ];

      for (const endpoint of endpoints) {
        const result = await jsonRequest<{ success: boolean; message: string }>(
          server.baseUrl,
          endpoint.path,
          {
            method: endpoint.method,
            headers: endpoint.body ? { 'content-type': 'application/json' } : undefined,
            body: endpoint.body ? JSON.stringify(endpoint.body) : undefined
          }
        );

        expect(result.response.status).toBe(401);
      }
    } finally {
      await server.close();
    }
  });

  it('returns connection status for authorized admin requests', async () => {
    const server = await createJsonTestServer(registerDashboardRoutes, {
      setupApp: async (app) => {
        setupTestAdminSession(app);
      }
    });

    try {
      const result = await jsonRequest<Record<string, any>>(
        server.baseUrl,
        '/api/dashboard/connection',
        {
          headers: {
            [TEST_ADMIN_HEADER]: 'true'
          }
        }
      );

      expect(result.response.status).toBe(200);
      expect(checkDatabaseConnectionMock).toHaveBeenCalledTimes(1);
      expect(result.body).toEqual({
        success: true,
        status: {
          currentStorage: 'postgres',
          connections: {
            postgres: true,
            supabase: { isConnected: false, disabled: true }
          }
        }
      });
    } finally {
      await server.close();
    }
  });

  it('returns operational metrics for authorized admin requests', async () => {
    const server = await createJsonTestServer(registerDashboardRoutes, {
      setupApp: async (app) => {
        setupTestAdminSession(app);
      }
    });

    try {
      const result = await jsonRequest<Record<string, any>>(
        server.baseUrl,
        '/api/dashboard/operational-metrics',
        {
          headers: {
            [TEST_ADMIN_HEADER]: 'true'
          }
        }
      );

      expect(result.response.status).toBe(200);
      expect(getOperationalMetricsSummaryMock).toHaveBeenCalledTimes(1);
      expect(result.body).toEqual({
        success: true,
        data: {
          generatedAt: '2026-04-10T00:00:00.000Z',
          auth: { adminLoginFailures: { total: 0, lastHour: 0, last15Minutes: 0, last5Minutes: 0 } }
        }
      });
    } finally {
      await server.close();
    }
  });

  it('rejects invalid backup ids before restore side effects happen', async () => {
    const server = await createJsonTestServer(registerDashboardRoutes, {
      setupApp: async (app) => {
        setupTestAdminSession(app);
      }
    });

    try {
      const result = await jsonRequest<Record<string, any>>(
        server.baseUrl,
        '/api/dashboard/backups/backup!bad/restore',
        {
          method: 'POST',
          headers: {
            [TEST_ADMIN_HEADER]: 'true',
            'content-type': 'application/json'
          },
          body: JSON.stringify({})
        }
      );

      expect(result.response.status).toBe(400);
      expect(createDatabaseBackupMock).not.toHaveBeenCalled();
      expect(restoreFromBackupMock).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it('rejects invalid backup ids before delete side effects happen', async () => {
    const server = await createJsonTestServer(registerDashboardRoutes, {
      setupApp: async (app) => {
        setupTestAdminSession(app);
      }
    });

    try {
      const result = await jsonRequest<Record<string, any>>(
        server.baseUrl,
        '/api/dashboard/backups/backup!bad',
        {
          method: 'DELETE',
          headers: {
            [TEST_ADMIN_HEADER]: 'true'
          }
        }
      );

      expect(result.response.status).toBe(400);
      expect(deleteBackupMock).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });
});
