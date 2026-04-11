import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createJsonTestServer, jsonRequest } from '../test-utils/http-test-server';
import {
  setupTestAdminSession,
  TEST_ADMIN_HEADER,
  TEST_SCAN_UNLOCK_HEADER
} from '../test-utils/admin-test-session';

const attendanceState = vi.hoisted(() => ({
  todayDateKey: '2026-04-09',
  attendanceRecords: [] as Array<Record<string, any>>,
  employees: [] as Array<Record<string, any>>
}));

const storageMock = vi.hoisted(() => ({
  getTemporaryAttendance: vi.fn(async () => attendanceState.attendanceRecords),
  getTemporaryAttendancePage: vi.fn(async (page: number, limit: number) => ({
    rows: attendanceState.attendanceRecords.slice(0, limit),
    total: attendanceState.attendanceRecords.length,
    page,
    limit
  })),
  getTemporaryAttendanceByDate: vi.fn(async (_date: string) => attendanceState.attendanceRecords),
  getAllEmployees: vi.fn(async () => attendanceState.employees),
  getSettings: vi.fn(async () => null)
}));

vi.mock('../storage', () => ({
  storage: storageMock
}));

vi.mock('./attendance-helpers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./attendance-helpers')>();
  return {
    ...actual,
    getTodayDateKey: vi.fn(() => attendanceState.todayDateKey)
  };
});

let registerAttendanceRoutes: typeof import('./attendance.routes').registerAttendanceRoutes;

beforeAll(async () => {
  ({ registerAttendanceRoutes } = await import('./attendance.routes'));
});

afterEach(() => {
  process.env.NODE_ENV = 'test';
  delete process.env.SESSION_SECRET;
  delete process.env.SESSION_SECURE;
});

beforeEach(() => {
  attendanceState.todayDateKey = '2026-04-09';
  attendanceState.attendanceRecords = [
    {
      id: 11,
      employeeId: 5,
      date: '2026-04-09',
      clockIn: '08:30',
      clockOut: '17:20',
      isHoliday: false,
      isBarcodeScanned: true,
      holidayId: null,
      holidayType: null
    }
  ];
  attendanceState.employees = [
    {
      id: 5,
      name: 'Test Employee',
      department: 'Ops'
    }
  ];
  vi.clearAllMocks();
});

describe('attendance routes integration', () => {
  it('defaults attendance list requests to bounded pagination when page and limit are omitted', async () => {
    const server = await createJsonTestServer(registerAttendanceRoutes, {
      setupApp: async (app) => {
        setupTestAdminSession(app);
      }
    });

    try {
      const result = await jsonRequest<{
        data: Array<Record<string, unknown>>;
        pagination: { page: number; limit: number; total: number; pages: number };
      }>(server.baseUrl, '/api/attendance', {
        headers: {
          [TEST_ADMIN_HEADER]: 'true'
        }
      });

      expect(result.response.status).toBe(200);
      expect(result.body).toEqual({
        data: [
          expect.objectContaining({
            id: 11,
            employeeId: 5,
            date: '2026-04-09',
            clockIn: '08:30',
            clockOut: '17:20'
          })
        ],
        pagination: {
          page: 1,
          limit: 50,
          total: 1,
          pages: 1
        }
      });
      expect(storageMock.getTemporaryAttendancePage).toHaveBeenCalledWith(1, 50);
      expect(storageMock.getTemporaryAttendance).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it('requires a kiosk/admin session in production and returns sanitized records without employee ids', async () => {
    process.env.NODE_ENV = 'production';
    process.env.SESSION_SECRET = 'attendance-session-secret-1234567890123456';
    process.env.SESSION_SECURE = 'false';

    const server = await createJsonTestServer(registerAttendanceRoutes, {
      setupApp: async (app) => {
        setupTestAdminSession(app);
      }
    });

    try {
      const lockedResult = await jsonRequest<Record<string, unknown>>(
        server.baseUrl,
        '/api/attendance/today'
      );

      expect(lockedResult.response.status).toBe(401);
      expect(lockedResult.response.headers.get('x-scan-session-required')).toBe('true');

      const unlockedResult = await jsonRequest<Array<Record<string, unknown>>>(
        server.baseUrl,
        '/api/attendance/today',
        {
          headers: {
            [TEST_SCAN_UNLOCK_HEADER]: 'true'
          }
        }
      );

      expect(unlockedResult.response.status).toBe(200);
      expect(unlockedResult.body).toEqual([
        expect.objectContaining({
          id: 11,
          employeeName: 'Test Employee',
          department: 'Ops',
          date: '2026-04-09',
          clockIn: '08:30',
          clockOut: '17:20',
          isBarcodeScanned: true
        })
      ]);
      expect(unlockedResult.body?.[0]).not.toHaveProperty('employeeId');
    } finally {
      await server.close();
    }
  });

  it('allows an authenticated admin session to read the sanitized kiosk attendance feed', async () => {
    process.env.NODE_ENV = 'production';
    process.env.SESSION_SECRET = 'attendance-session-secret-1234567890123456';
    process.env.SESSION_SECURE = 'false';

    const server = await createJsonTestServer(registerAttendanceRoutes, {
      setupApp: async (app) => {
        setupTestAdminSession(app);
      }
    });

    try {
      const result = await jsonRequest<Array<Record<string, unknown>>>(
        server.baseUrl,
        '/api/attendance/today',
        {
          headers: {
            [TEST_ADMIN_HEADER]: 'true'
          }
        }
      );

      expect(result.response.status).toBe(200);
      expect(result.body).toEqual([
        expect.objectContaining({
          id: 11,
          employeeName: 'Test Employee',
          department: 'Ops',
          date: '2026-04-09',
          clockIn: '08:30',
          clockOut: '17:20',
          isBarcodeScanned: true
        })
      ]);
      expect(result.body?.[0]).not.toHaveProperty('employeeId');
    } finally {
      await server.close();
    }
  });
});
