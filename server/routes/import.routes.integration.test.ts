import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createJsonTestServer, jsonRequest } from '../test-utils/http-test-server';
import { TEST_ADMIN_HEADER, setupTestAdminSession } from '../test-utils/admin-test-session';

const importState = vi.hoisted(() => ({
  attendanceInserts: [] as Array<Record<string, unknown>>,
  existingSalaryRecord: null as null | { id: number },
  updatedSalaryPayload: null as null | Record<string, unknown>,
  createdSalaryPayload: null as null | Record<string, unknown>
}));

const storageMock = vi.hoisted(() => ({
  createTemporaryAttendance: vi.fn(async (payload: Record<string, unknown>) => {
    importState.attendanceInserts.push(payload);
    return {
      id: importState.attendanceInserts.length,
      ...payload,
      createdAt: new Date('2026-03-12T00:00:00.000Z')
    };
  }),
  getSalaryRecordByYearMonth: vi.fn(async () => importState.existingSalaryRecord),
  updateSalaryRecord: vi.fn(async (id: number, payload: Record<string, unknown>) => {
    importState.updatedSalaryPayload = payload;
    return {
      id,
      ...payload,
      createdAt: new Date('2026-03-12T00:00:00.000Z')
    };
  }),
  createSalaryRecord: vi.fn(async (payload: Record<string, unknown>) => {
    importState.createdSalaryPayload = payload;
    return {
      id: 99,
      ...payload,
      createdAt: new Date('2026-03-12T00:00:00.000Z')
    };
  })
}));

vi.mock('../storage', () => ({
  storage: storageMock
}));

vi.mock('../middleware/rateLimiter', () => ({
  strictLimiter: (_req: unknown, _res: unknown, next: () => void) => next()
}));

vi.mock('../middleware/requireAdmin', () => ({
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

let registerImportRoutes: typeof import('./import.routes').registerImportRoutes;

beforeAll(async () => {
  ({ registerImportRoutes } = await import('./import.routes'));
});

beforeEach(() => {
  importState.attendanceInserts = [];
  importState.existingSalaryRecord = null;
  importState.updatedSalaryPayload = null;
  importState.createdSalaryPayload = null;
  vi.clearAllMocks();
});

describe('import routes integration', () => {
  it('rejects admin import requests without server-side authorization headers', async () => {
    const server = await createJsonTestServer(registerImportRoutes, {
      setupApp: async (app) => {
        setupTestAdminSession(app);
      }
    });

    try {
      const result = await jsonRequest<{ success: boolean; message: string }>(
        server.baseUrl,
        '/api/admin/import/attendance',
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json'
          },
          body: JSON.stringify({
            csvContent: '日期,上班時間,下班時間\n2026-03-12,08:00,17:00'
          })
        }
      );

      expect(result.response.status).toBe(401);
      expect(result.body).toEqual({
        success: false,
        message: '缺少管理員授權，請重新登入管理員模式'
      });
    } finally {
      await server.close();
    }
  });

  it('imports attendance csv rows through the route and persists normalized records', async () => {
    const server = await createJsonTestServer(registerImportRoutes, {
      setupApp: async (app) => {
        setupTestAdminSession(app);
      }
    });

    try {
      const result = await jsonRequest<{
        success: boolean;
        successCount: number;
        failCount: number;
        totalRecords: number;
        message: string;
      }>(server.baseUrl, '/api/admin/import/attendance', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [TEST_ADMIN_HEADER]: 'true'
        },
        body: JSON.stringify({
          csvContent: [
            '日期,上班時間,下班時間,是否假日',
            '2026-03-12,08:00,17:00,false',
            '2026/03/13,08:30,17:30,是'
          ].join('\n')
        })
      });

      expect(result.response.status).toBe(200);
      expect(result.body?.successCount).toBe(2);
      expect(result.body?.failCount).toBe(0);
      expect(importState.attendanceInserts).toEqual([
        {
          date: '2026/03/12',
          clockIn: '08:00',
          clockOut: '17:00',
          isHoliday: false
        },
        {
          date: '2026/03/13',
          clockIn: '08:30',
          clockOut: '17:30',
          isHoliday: true
        }
      ]);
    } finally {
      await server.close();
    }
  });

  it('updates an existing salary record and converts imported attendance into historical snapshots', async () => {
    importState.existingSalaryRecord = { id: 7 };
    const server = await createJsonTestServer(registerImportRoutes, {
      setupApp: async (app) => {
        setupTestAdminSession(app);
      }
    });

    try {
      const result = await jsonRequest<{
        success: boolean;
        message: string;
        record: { id: number; attendanceData: Array<{ id: number; date: string }> };
      }>(server.baseUrl, '/api/admin/import/salary-record', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [TEST_ADMIN_HEADER]: 'true'
        },
        body: JSON.stringify({
          csvContent: [
            '薪資年份,薪資月份,基本底薪,福利津貼,加班總時數OT1,加班總時數OT2,加班總費用,假日天數,假日總薪資,總薪資,總扣除額,實領金額',
            '2026,3,30000,500,10,5,2500,2,2000,35000,1200,33800',
            '扣除項目',
            '勞保費,300',
            '考勤詳細記錄',
            '日期,上班時間,下班時間,是否假日',
            '2026-03-01,08:00,17:00,false',
            '2026/03/02,08:00,17:00,是'
          ].join('\n')
        })
      });

      expect(result.response.status).toBe(200);
      expect(result.body?.success).toBe(true);
      expect(storageMock.updateSalaryRecord).toHaveBeenCalledOnce();
      expect(importState.updatedSalaryPayload).toMatchObject({
        salaryYear: 2026,
        salaryMonth: 3,
        attendanceData: [
          {
            id: 1,
            date: '2026/03/01',
            clockIn: '08:00',
            clockOut: '17:00',
            isHoliday: false,
            isBarcodeScanned: false
          },
          {
            id: 2,
            date: '2026/03/02',
            clockIn: '08:00',
            clockOut: '17:00',
            isHoliday: true,
            isBarcodeScanned: false
          }
        ]
      });
    } finally {
      await server.close();
    }
  });
});
