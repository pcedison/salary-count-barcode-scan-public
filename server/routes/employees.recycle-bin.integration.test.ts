import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createJsonTestServer, jsonRequest } from '../test-utils/http-test-server';
import { TEST_ADMIN_HEADER, setupTestAdminSession } from '../test-utils/admin-test-session';

const recycleBinState = vi.hoisted(() => ({
  employee: {
    id: 5,
    name: '回收桶測試員工',
    idNumber: 'A123456789',
    isEncrypted: false,
    employeeType: 'local' as const,
    position: '作業員',
    department: '製造部',
    email: null,
    phone: null,
    active: true,
    lineUserId: 'U-line-bound',
    lineDisplayName: 'Line Bound',
    linePictureUrl: 'https://example.com/avatar.png',
    lineBindingDate: new Date('2026-04-01T00:00:00.000Z'),
    specialLeaveDays: 0,
    specialLeaveWorkDateRange: null,
    specialLeaveUsedDates: [] as string[],
    specialLeaveCashDays: 0,
    specialLeaveCashMonth: null,
    specialLeaveNotes: null,
    deletedAt: null as Date | null,
    deletedBy: null as string | null,
    purgeAfterAt: null as Date | null,
    createdAt: new Date('2026-03-01T00:00:00.000Z')
  }
}));

const storageMock = vi.hoisted(() => ({
  getAllEmployees: vi.fn(async () =>
    recycleBinState.employee.deletedAt ? [] : [recycleBinState.employee]
  ),
  getDeletedEmployees: vi.fn(async () =>
    recycleBinState.employee.deletedAt ? [recycleBinState.employee] : []
  ),
  getEmployeeById: vi.fn(async (id: number) =>
    id === recycleBinState.employee.id && !recycleBinState.employee.deletedAt
      ? recycleBinState.employee
      : undefined
  ),
  getEmployeeByIdIncludingDeleted: vi.fn(async (id: number) =>
    id === recycleBinState.employee.id
      ? recycleBinState.employee
      : undefined
  ),
  deleteEmployee: vi.fn(async (id: number, deletedBy = 'admin') => {
    if (id !== recycleBinState.employee.id || recycleBinState.employee.deletedAt) {
      return false;
    }

    recycleBinState.employee = {
      ...recycleBinState.employee,
      deletedAt: new Date('2026-04-08T02:00:00.000Z'),
      deletedBy,
      purgeAfterAt: new Date('2026-05-08T02:00:00.000Z'),
      lineUserId: null,
      lineDisplayName: null,
      linePictureUrl: null,
      lineBindingDate: null
    };
    return true;
  }),
  restoreEmployee: vi.fn(async (id: number) => {
    if (id !== recycleBinState.employee.id || !recycleBinState.employee.deletedAt) {
      return undefined;
    }

    recycleBinState.employee = {
      ...recycleBinState.employee,
      deletedAt: null,
      deletedBy: null,
      purgeAfterAt: null
    };
    return recycleBinState.employee;
  }),
  purgeEmployee: vi.fn(async (id: number) => {
    if (id !== recycleBinState.employee.id || !recycleBinState.employee.deletedAt) {
      return {
        purged: false,
        anonymizedSalaryRecords: 0
      };
    }

    recycleBinState.employee = {
      ...recycleBinState.employee,
      deletedAt: new Date('2026-04-08T02:00:00.000Z')
    };

    return {
      purged: true,
      anonymizedSalaryRecords: 3
    };
  }),
  getSettings: vi.fn(async () => ({ barcodeEnabled: true }))
}));

vi.mock('../storage', () => ({
  storage: storageMock
}));

vi.mock('../middleware/requireAdmin', () => ({
  requireAdmin: () => (
    req: { session?: { adminAuth?: { isAdmin?: boolean } } },
    res: { status: (code: number) => { json: (body: unknown) => unknown } },
    next: () => void
  ) => {
    if (!req.session?.adminAuth?.isAdmin) {
      return res.status(401).json({
        success: false,
        message: 'Admin authorization required'
      });
    }

    next();
  }
}));

let registerEmployeeRoutes: typeof import('./employees.routes').registerEmployeeRoutes;

beforeAll(async () => {
  ({ registerEmployeeRoutes } = await import('./employees.routes'));
});

beforeEach(() => {
  recycleBinState.employee = {
    id: 5,
    name: '回收桶測試員工',
    idNumber: 'A123456789',
    isEncrypted: false,
    employeeType: 'local',
    position: '作業員',
    department: '製造部',
    email: null,
    phone: null,
    active: true,
    lineUserId: 'U-line-bound',
    lineDisplayName: 'Line Bound',
    linePictureUrl: 'https://example.com/avatar.png',
    lineBindingDate: new Date('2026-04-01T00:00:00.000Z'),
    specialLeaveDays: 0,
    specialLeaveWorkDateRange: null,
    specialLeaveUsedDates: [],
    specialLeaveCashDays: 0,
    specialLeaveCashMonth: null,
    specialLeaveNotes: null,
    deletedAt: null,
    deletedBy: null,
    purgeAfterAt: null,
    createdAt: new Date('2026-03-01T00:00:00.000Z')
  };
  vi.clearAllMocks();
});

describe('employee recycle-bin routes integration', () => {
  it('soft deletes employees and moves them into the deleted list', async () => {
    const server = await createJsonTestServer(registerEmployeeRoutes, {
      setupApp: async (app) => {
        setupTestAdminSession(app);
      }
    });

    try {
      const deleted = await jsonRequest<null>(server.baseUrl, '/api/employees/5', {
        method: 'DELETE',
        headers: {
          [TEST_ADMIN_HEADER]: 'true'
        }
      });

      expect(deleted.response.status).toBe(204);
      expect(storageMock.deleteEmployee).toHaveBeenCalledWith(5, 'admin');

      const adminList = await jsonRequest<Array<Record<string, unknown>>>(
        server.baseUrl,
        '/api/employees/admin',
        {
          headers: {
            [TEST_ADMIN_HEADER]: 'true'
          }
        }
      );

      expect(adminList.response.status).toBe(200);
      expect(adminList.body).toEqual([]);

      const deletedList = await jsonRequest<Array<Record<string, unknown>>>(
        server.baseUrl,
        '/api/employees/deleted',
        {
          headers: {
            [TEST_ADMIN_HEADER]: 'true'
          }
        }
      );

      expect(deletedList.response.status).toBe(200);
      expect(deletedList.body).toHaveLength(1);
      expect(deletedList.body[0]).toMatchObject({
        id: 5,
        deletedBy: 'admin',
        lineUserId: null,
        lineDisplayName: null,
        recycleRetentionDays: 30,
        salaryRetentionMode: 'anonymized',
        salaryRetentionYears: 5,
        lineRestoreMode: 'rebind_required'
      });
    } finally {
      await server.close();
    }
  });

  it('restores soft-deleted employees and marks LINE for rebind', async () => {
    recycleBinState.employee = {
      ...recycleBinState.employee,
      deletedAt: new Date('2026-04-08T02:00:00.000Z'),
      deletedBy: 'admin',
      purgeAfterAt: new Date('2026-05-08T02:00:00.000Z'),
      lineUserId: null,
      lineDisplayName: null,
      linePictureUrl: null,
      lineBindingDate: null
    };

    const server = await createJsonTestServer(registerEmployeeRoutes, {
      setupApp: async (app) => {
        setupTestAdminSession(app);
      }
    });

    try {
      const restored = await jsonRequest<Record<string, unknown>>(
        server.baseUrl,
        '/api/employees/5/restore',
        {
          method: 'POST',
          headers: {
            [TEST_ADMIN_HEADER]: 'true'
          }
        }
      );

      expect(restored.response.status).toBe(200);
      expect(restored.body).toMatchObject({
        id: 5,
        requiresLineRebind: true,
        lineUserId: null,
        lineRestoreMode: 'rebind_required'
      });
      expect(storageMock.restoreEmployee).toHaveBeenCalledWith(5);

      const adminList = await jsonRequest<Array<Record<string, unknown>>>(
        server.baseUrl,
        '/api/employees/admin',
        {
          headers: {
            [TEST_ADMIN_HEADER]: 'true'
          }
        }
      );

      expect(adminList.response.status).toBe(200);
      expect(adminList.body).toEqual([
        expect.objectContaining({
          id: 5,
          name: '回收桶測試員工'
        })
      ]);
    } finally {
      await server.close();
    }
  });

  it('permanently purges employees that are already in the recycle bin', async () => {
    recycleBinState.employee = {
      ...recycleBinState.employee,
      deletedAt: new Date('2026-04-08T02:00:00.000Z'),
      deletedBy: 'admin',
      purgeAfterAt: new Date('2026-05-08T02:00:00.000Z'),
      lineUserId: null,
      lineDisplayName: null,
      linePictureUrl: null,
      lineBindingDate: null
    };

    const server = await createJsonTestServer(registerEmployeeRoutes, {
      setupApp: async (app) => {
        setupTestAdminSession(app);
      }
    });

    try {
      const purgeResult = await jsonRequest<Record<string, unknown>>(
        server.baseUrl,
        '/api/employees/5/purge',
        {
          method: 'DELETE',
          headers: {
            'content-type': 'application/json',
            [TEST_ADMIN_HEADER]: 'true'
          },
          body: JSON.stringify({
            confirmName: '回收桶測試員工'
          })
        }
      );

      expect(purgeResult.response.status).toBe(200);
      expect(purgeResult.body).toEqual({
        success: true,
        anonymizedSalaryRecords: 3
      });
      expect(storageMock.getEmployeeByIdIncludingDeleted).toHaveBeenCalledWith(5);
      expect(storageMock.purgeEmployee).toHaveBeenCalledWith(5);
    } finally {
      await server.close();
    }
  });
});
