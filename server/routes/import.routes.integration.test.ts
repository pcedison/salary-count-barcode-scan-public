import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createJsonTestServer, jsonRequest } from '../test-utils/http-test-server';
import { TEST_ADMIN_HEADER, setupTestAdminSession } from '../test-utils/admin-test-session';
import { buildSalaryRecordCsv } from '../../client/src/lib/historyExport';

const importState = vi.hoisted(() => ({
  attendanceInserts: [] as Array<Record<string, unknown>>,
  existingSalaryRecords: [] as Array<{ id: number; salaryYear: number; salaryMonth: number; employeeId: number | null }>,
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
  getSalaryRecordsByYearMonth: vi.fn(async (year: number, month: number) =>
    importState.existingSalaryRecords.filter((record) => record.salaryYear === year && record.salaryMonth === month)
  ),
  getSalaryRecordById: vi.fn(async (id: number) => importState.existingSalaryRecords.find((record) => record.id === id)),
  getSalaryRecordByYearMonthEmployee: vi.fn(async (year: number, month: number, employeeId: number) =>
    importState.existingSalaryRecords.find((record) => record.salaryYear === year && record.salaryMonth === month && record.employeeId === employeeId)
  ),
  getEmployeeById: vi.fn(async (id: number) =>
    id === 11 || id === 12 ? { id, name: `Test Employee ${id}`, active: true } : undefined
  ),
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

vi.mock('../repositories/salaryRepository', () => ({ salaryRepository: storageMock }));
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
  importState.existingSalaryRecords = [];
  importState.updatedSalaryPayload = null;
  importState.createdSalaryPayload = null;
  vi.clearAllMocks();
});

describe('import routes integration', () => {
  it.each([32000, null])('preserves provided calculation basis or unknown legacy null during a fresh CSV restore: %s', async (basis) => {
    const server = await createImportTestServer();
    const csvContent = buildSalaryRecordCsv({ id: 91, revision: 0, employeeId: 11,
      salaryYear: 2026, salaryMonth: 3, baseSalary: 30000,
      holidayCalculationBaseSalary: basis, grossSalary: 30000, netSalary: 30000, attendanceData: [],
    });
    try {
      const result = await submitSalary(server.baseUrl, { csvContent, employeeId: 11 });
      expect(result.response.status).toBe(200);
      expect(importState.createdSalaryPayload).toMatchObject({
        baseSalary: 30000, holidayCalculationBaseSalary: basis,
      });
    } finally { await server.close(); }
  });
  const salaryCsv = [
    '薪資年份,薪資月份,基本底薪,總薪資,實領額',
    '2026,3,30000,30000,30000',
    '考勤詳細記錄',
    '日期,上班時間,下班時間,是否假日',
    '2026/03/01,08:00,17:00,false'
  ].join('\n');

  async function createImportTestServer() {
    return createJsonTestServer(registerImportRoutes, { setupApp: setupTestAdminSession });
  }
  async function submitSalary(baseUrl: string, options: Record<string, unknown> = {}, authenticated = true) {
    return jsonRequest<Record<string, any>>(baseUrl, '/api/admin/import/salary-record', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(authenticated ? { [TEST_ADMIN_HEADER]: 'true' } : {}) },
      body: JSON.stringify({ csvContent: salaryCsv, ...options })
    });
  }
  function employeeSalary(id: number, employeeId: number, month = 3) {
    return { id, employeeId, salaryYear: 2026, salaryMonth: month };
  }

  it('refuses an ambiguous month without an explicit import target', async () => {
    importState.existingSalaryRecords = [employeeSalary(7, 11), employeeSalary(8, 12)];
    const server = await createImportTestServer();
    try {
      const result = await submitSalary(server.baseUrl);
      expect(result.response.status).toBe(409);
      expect(result.body?.code).toBe('SALARY_IMPORT_TARGET_REQUIRED');
      expect(storageMock.updateSalaryRecord).not.toHaveBeenCalled();
      expect(storageMock.createSalaryRecord).not.toHaveBeenCalled();
    } finally { await server.close(); }
  });

  it('does not overwrite the only employee payroll without an explicit target', async () => {
    importState.existingSalaryRecords = [employeeSalary(7, 11)];
    const server = await createImportTestServer();
    try {
      const result = await submitSalary(server.baseUrl);
      expect(result.response.status).toBe(409);
      expect(storageMock.updateSalaryRecord).not.toHaveBeenCalled();
      expect(storageMock.createSalaryRecord).not.toHaveBeenCalled();
    } finally { await server.close(); }
  });

  it('rejects overwriting an explicitly selected existing record even without a correction journal', async () => {
    importState.existingSalaryRecords = [employeeSalary(7, 11), employeeSalary(8, 12)];
    const server = await createImportTestServer();
    try {
      const result = await submitSalary(server.baseUrl, { recordId: 8, employeeId: 12 });
      expect(result.response.status).toBe(409);
      expect(result.body?.code).toBe('CORRECTION_REQUIRED');
      expect(storageMock.updateSalaryRecord).not.toHaveBeenCalled();
      expect(storageMock.createSalaryRecord).not.toHaveBeenCalled();
    } finally { await server.close(); }
  });

  it.each([{ recordId: 7, employeeId: 12 }, { recordId: 9 }])('rejects a target employee or month mismatch: %j', async (options) => {
    importState.existingSalaryRecords = [employeeSalary(7, 11), employeeSalary(9, 11, 2)];
    const server = await createImportTestServer();
    try {
      const result = await submitSalary(server.baseUrl, options);
      expect(result.response.status).toBe(409);
      expect(result.body?.code).toBe('SALARY_IMPORT_TARGET_MISMATCH');
      expect(storageMock.updateSalaryRecord).not.toHaveBeenCalled();
      expect(storageMock.createSalaryRecord).not.toHaveBeenCalled();
    } finally { await server.close(); }
  });

  it('uses the selected employee and month instead of another employee payroll', async () => {
    importState.existingSalaryRecords = [employeeSalary(8, 12)];
    const server = await createImportTestServer();
    try {
      const result = await submitSalary(server.baseUrl, { employeeId: 11 });
      expect(result.response.status).toBe(200);
      expect(storageMock.getSalaryRecordByYearMonthEmployee).toHaveBeenCalledWith(2026, 3, 11);
      expect(storageMock.updateSalaryRecord).not.toHaveBeenCalled();
      expect(importState.createdSalaryPayload).toMatchObject({ employeeId: 11, employeeName: 'Test Employee 11' });
    } finally { await server.close(); }
  });

  it('rejects overwriting an existing exact employee/month target', async () => {
    importState.existingSalaryRecords = [employeeSalary(7, 11), employeeSalary(8, 12)];
    const server = await createImportTestServer();
    try {
      const result = await submitSalary(server.baseUrl, { employeeId: 11 });
      expect(result.response.status).toBe(409);
      expect(result.body?.code).toBe('CORRECTION_REQUIRED');
      expect(storageMock.updateSalaryRecord).not.toHaveBeenCalled();
      expect(storageMock.createSalaryRecord).not.toHaveBeenCalled();
    } finally { await server.close(); }
  });

  it.each([{ employeeId: '11' }, { employeeId: 0 }, { recordId: -1 }, { recordId: null }, { employeeId: 1.5 }])('rejects malformed import scope: %j', async (options) => {
    const server = await createImportTestServer();
    try {
      const result = await submitSalary(server.baseUrl, options);
      expect(result.response.status).toBe(400);
      expect(storageMock.updateSalaryRecord).not.toHaveBeenCalled();
      expect(storageMock.createSalaryRecord).not.toHaveBeenCalled();
    } finally { await server.close(); }
  });

  it.each([{ employeeId: 999 }, { recordId: 999 }])('rejects nonexistent explicit targets: %j', async (options) => {
    const server = await createImportTestServer();
    try {
      const result = await submitSalary(server.baseUrl, options);
      expect(result.response.status).toBe(404);
      expect(storageMock.updateSalaryRecord).not.toHaveBeenCalled();
      expect(storageMock.createSalaryRecord).not.toHaveBeenCalled();
    } finally { await server.close(); }
  });

  it('does not overwrite a record with salary corrections', async () => {
    importState.existingSalaryRecords = [employeeSalary(7, 11)];
    const server = await createImportTestServer();
    try {
      const result = await submitSalary(server.baseUrl, { recordId: 7 });
      expect(result.response.status).toBe(409);
      expect(result.body?.code).toBe('CORRECTION_REQUIRED');
      expect(result.text).not.toContain('synthetic-private-payroll');
      expect(importState.updatedSalaryPayload).toBeNull();
      expect(storageMock.updateSalaryRecord).not.toHaveBeenCalled();
      expect(storageMock.createSalaryRecord).not.toHaveBeenCalled();
    } finally { await server.close(); }
  });

  it('rejects attendance from outside the salary month before writing', async () => {
    const server = await createImportTestServer();
    try {
      const result = await submitSalary(server.baseUrl, { csvContent: salaryCsv.replace('2026/03/01', '2026/04/01') });
      expect(result.response.status).toBe(400);
      expect(storageMock.updateSalaryRecord).not.toHaveBeenCalled();
      expect(storageMock.createSalaryRecord).not.toHaveBeenCalled();
    } finally { await server.close(); }
  });

  it('rejects invalid salary month and malformed CSV without writing', async () => {
    const server = await createImportTestServer();
    try {
      const invalidMonth = await submitSalary(server.baseUrl, { csvContent: salaryCsv.replace('2026,3,', '2026,13,') });
      expect(invalidMonth.response.status).toBe(400);
      const malformedCsv = await submitSalary(server.baseUrl, { csvContent: 'invalid' });
      expect(malformedCsv.response.status).toBe(400);
      expect(storageMock.updateSalaryRecord).not.toHaveBeenCalled();
      expect(storageMock.createSalaryRecord).not.toHaveBeenCalled();
    } finally { await server.close(); }
  });

  it('requires authorization even when an employee is explicitly selected', async () => {
    const server = await createImportTestServer();
    try {
      const result = await submitSalary(server.baseUrl, { employeeId: 11 }, false);
      expect(result.response.status).toBe(401);
      expect(storageMock.getEmployeeById).not.toHaveBeenCalled();
      expect(storageMock.createSalaryRecord).not.toHaveBeenCalled();
    } finally { await server.close(); }
  });

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

  it('restores a missing legacy anonymous salary record and converts attendance into historical snapshots', async () => {
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
      expect(storageMock.updateSalaryRecord).not.toHaveBeenCalled();
      expect(storageMock.createSalaryRecord).toHaveBeenCalledOnce();
      expect(importState.createdSalaryPayload).toMatchObject({
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

  function exportedSnapshot(revision = 0) {
    return buildSalaryRecordCsv({ id: 7, revision, employeeId: 11, employeeName: 'Synthetic, "employee"', salaryYear: 2026, salaryMonth: 3, baseSalary: 30000, housingAllowance: 0, welfareAllowance: 0, totalOT1Hours: 0, totalOT2Hours: 0, totalOvertimePay: 0, holidayDays: 0, holidayDailySalary: 1000, holidayCalculationBaseSalary: 30000, totalHolidayPay: 0, grossSalary: 30000, totalDeductions: 0, netSalary: 30000, deductions: [], allowances: [], attendanceData: [{ date: '2026-03-01', clockIn: '--:--', clockOut: '--:--', isHoliday: true, holidayType: 'national_holiday' }] });
  }

  it('restores a newly exported unmodified snapshot only for the explicitly matching employee', async () => {
    const server = await createImportTestServer();
    try {
      const result = await submitSalary(server.baseUrl, { csvContent: exportedSnapshot(), employeeId: 11 });
      expect(result.response.status).toBe(200);
      expect(importState.createdSalaryPayload).toMatchObject({ employeeId: 11, baseSalary: 30000, holidayCalculationBaseSalary: 30000, netSalary: 30000, attendanceData: [expect.objectContaining({ employeeId: 11, date: '2026/03/01', holidayType: 'national_holiday', clockIn: '--:--', clockOut: '--:--' })] });
      expect(importState.createdSalaryPayload).not.toHaveProperty('snapshotRevision');
      expect(storageMock.updateSalaryRecord).not.toHaveBeenCalled();
    } finally { await server.close(); }
  });

  it('rejects a new snapshot for another employee or without a request target', async () => {
    const server = await createImportTestServer();
    try {
      for (const target of [{ employeeId: 12 }, {}]) {
        const result = await submitSalary(server.baseUrl, { csvContent: exportedSnapshot(), ...target });
        expect(result.response.status).toBe(409);
        expect(result.body?.code).toBe('SALARY_IMPORT_TARGET_MISMATCH');
      }
      expect(storageMock.createSalaryRecord).not.toHaveBeenCalled();
      expect(storageMock.updateSalaryRecord).not.toHaveBeenCalled();
    } finally { await server.close(); }
  });

  it('returns correction-required rather than format-error for its own corrected export', async () => {
    importState.existingSalaryRecords = [employeeSalary(7, 11)];
    const server = await createImportTestServer();
    try {
      const result = await submitSalary(server.baseUrl, { csvContent: exportedSnapshot(1), recordId: 7 });
      expect(result.response.status).toBe(409);
      expect(result.body?.code).toBe('CORRECTION_REQUIRED');
      expect(storageMock.updateSalaryRecord).not.toHaveBeenCalled();
      expect(storageMock.createSalaryRecord).not.toHaveBeenCalled();
    } finally { await server.close(); }
  });

  it('never overwrites an existing anonymous settlement through the legacy fallback', async () => {
    importState.existingSalaryRecords = [{ id: 7, employeeId: null, salaryYear: 2026, salaryMonth: 3 }];
    const server = await createImportTestServer();
    try {
      const result = await submitSalary(server.baseUrl);
      expect(result.response.status).toBe(409);
      expect(result.body?.code).toBe('CORRECTION_REQUIRED');
      expect(storageMock.createSalaryRecord).not.toHaveBeenCalled();
      expect(storageMock.updateSalaryRecord).not.toHaveBeenCalled();
    } finally { await server.close(); }
  });
});
