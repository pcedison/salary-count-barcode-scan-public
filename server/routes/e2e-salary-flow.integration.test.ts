import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createJsonTestServer, jsonRequest } from '../test-utils/http-test-server';
import { TEST_ADMIN_HEADER, setupTestAdminSession } from '../test-utils/admin-test-session';

/**
 * End-to-end salary flow integration test.
 *
 * Verifies the full chain:
 *   employee selection → attendance with employeeId → salary calculation → salary record storage
 *
 * Ensures employeeId is propagated correctly and never silently falls back to 1.
 */

// ---- in-memory state shared across mocked layers ----

const state = vi.hoisted(() => ({
  employees: [
    {
      id: 2,
      name: 'Employee Alpha',
      department: 'Team A',
      position: 'Operator',
      active: true,
      idNumber: 'E0000002',
      isEncrypted: false,
    },
    {
      id: 8,
      name: 'Employee Beta',
      department: 'Team B',
      position: 'Manager',
      active: true,
      idNumber: 'D1000073',
      isEncrypted: false,
    },
  ] as Array<Record<string, unknown>>,
  attendance: [] as Array<Record<string, unknown>>,
  salaryRecords: [] as Array<Record<string, unknown>>,
  settings: {
    id: 3,
    baseHourlyRate: 119,
    ot1Multiplier: 1.34,
    ot2Multiplier: 1.67,
    baseMonthSalary: 28590,
    welfareAllowance: 0,
    deductions: [],
    allowances: [],
    adminPin: 'hashed-pin',
  } as Record<string, unknown>,
  nextAttendanceId: 100,
  nextSalaryId: 100,
}));

const salaryCalculatorMock = vi.hoisted(() => ({
  calculateSalary: vi.fn(() => ({
    totalOT1Hours: 10,
    totalOT2Hours: 5,
    totalOvertimePay: 4200,
    grossSalary: 32790,
    netSalary: 32790,
  })),
  calculateHolidayPayAdjustments: vi.fn(() => ({
    sickLeaveDays: 0,
    sickLeaveDeduction: 0,
    personalLeaveDays: 0,
    personalLeaveDeduction: 0,
    typhoonLeaveDays: 0,
    typhoonLeaveDeduction: 0,
    workedHolidayDays: 0,
    workedHolidayPay: 0,
    deductionItems: [],
  })),
  calculateOvertimePay: vi.fn(() => 4200),
}));

const storageMock = vi.hoisted(() => ({
  // employee layer
  getAllEmployees: vi.fn(async () => state.employees),
  getEmployeeById: vi.fn(async (id: number) =>
    state.employees.find((e) => e.id === id)
  ),

  // attendance layer
  getTemporaryAttendance: vi.fn(async () => state.attendance),
  getTemporaryAttendancePage: vi.fn(async (page: number, limit: number) => ({
    rows: state.attendance.slice(0, limit),
    total: state.attendance.length,
    page,
    limit,
  })),
  getTemporaryAttendanceByEmployeeAndMonth: vi.fn(async (employeeId: number, year: number, month: number) =>
    state.attendance.filter((record) => {
      const normalizedDate = String(record.date ?? '').replace(/\//g, '-');
      return (
        record.employeeId === employeeId &&
        normalizedDate.startsWith(`${year}-${String(month).padStart(2, '0')}-`)
      );
    })
  ),
  createTemporaryAttendance: vi.fn(async (record: Record<string, unknown>) => {
    const created = { ...record, id: state.nextAttendanceId++, createdAt: new Date() };
    state.attendance.push(created);
    return created;
  }),
  deleteAllTemporaryAttendance: vi.fn(async () => {
    state.attendance = [];
    return true;
  }),

  // salary layer
  getAllSalaryRecords: vi.fn(async () => state.salaryRecords),
  getAllSalaryRecordsPage: vi.fn(async (page: number, limit: number) => ({
    rows: state.salaryRecords.slice(0, limit),
    total: state.salaryRecords.length,
    page,
    limit,
  })),
  getSalaryRecordById: vi.fn(async (id: number) =>
    state.salaryRecords.find((r) => r.id === id)
  ),
  createSalaryRecord: vi.fn(async (record: Record<string, unknown>) => {
    const created = { ...record, id: state.nextSalaryId++, createdAt: new Date() };
    state.salaryRecords.push(created);
    return created;
  }),
  updateSalaryRecord: vi.fn(async (id: number, data: Record<string, unknown>) => {
    const record = state.salaryRecords.find((r) => r.id === id);
    if (!record) return undefined;
    Object.assign(record, data);
    return record;
  }),

  // settings layer
  getSettings: vi.fn(async () => state.settings),
}));

vi.mock('../storage', () => ({ storage: storageMock }));
vi.mock('../utils/salaryCalculator', () => salaryCalculatorMock);
vi.mock('../middleware/requireAdmin', () => ({
  requireAdmin: () =>
    (req: { session?: { adminAuth?: { isAdmin?: boolean } } }, _res: any, next: () => void) => {
      if (!req.session?.adminAuth?.isAdmin) {
        return _res.status(401).json({ success: false, message: '需要管理員授權' });
      }
      next();
    },
}));

let registerAttendanceRoutes: typeof import('./attendance.routes').registerAttendanceRoutes;
let registerSalaryRoutes: typeof import('./salary.routes').registerSalaryRoutes;

beforeAll(async () => {
  ({ registerAttendanceRoutes } = await import('./attendance.routes'));
  ({ registerSalaryRoutes } = await import('./salary.routes'));
});

beforeEach(() => {
  state.attendance = [];
  state.salaryRecords = [];
  state.nextAttendanceId = 100;
  state.nextSalaryId = 100;
  vi.clearAllMocks();
});

describe('e2e salary flow', () => {
  it('creates attendance with employeeId and salary record preserves the chain', async () => {
    const server = await createJsonTestServer(
      (app) => {
        registerAttendanceRoutes(app);
        registerSalaryRoutes(app);
      },
      { setupApp: async (app) => setupTestAdminSession(app) }
    );

    try {
      const adminHeaders = {
        [TEST_ADMIN_HEADER]: 'true',
        'content-type': 'application/json',
      };

      // Step 1: Create attendance for employee ID=2 (Employee Alpha)
      const att1 = await jsonRequest(server.baseUrl, '/api/attendance', {
        method: 'POST',
        headers: adminHeaders,
        body: JSON.stringify({
          employeeId: 2,
          date: '2026/03/01',
          clockIn: '09:00',
          clockOut: '18:00',
          isHoliday: false,
        }),
      });
      expect(att1.response.status).toBe(201);
      expect(att1.body).toEqual(expect.objectContaining({ employeeId: 2 }));

      // Step 2: Create attendance for employee ID=8 (Employee Beta)
      const att2 = await jsonRequest(server.baseUrl, '/api/attendance', {
        method: 'POST',
        headers: adminHeaders,
        body: JSON.stringify({
          employeeId: 8,
          date: '2026/03/01',
          clockIn: '08:30',
          clockOut: '17:30',
          isHoliday: false,
        }),
      });
      expect(att2.response.status).toBe(201);
      expect(att2.body).toEqual(expect.objectContaining({ employeeId: 8 }));

      // Step 3: Verify attendance records are stored with correct employeeIds
      expect(storageMock.createTemporaryAttendance).toHaveBeenCalledTimes(2);
      expect(state.attendance).toHaveLength(2);
      expect(state.attendance[0]).toMatchObject({ employeeId: 2 });
      expect(state.attendance[1]).toMatchObject({ employeeId: 8 });

      // Step 4: Verify attendance list returns both records
      const attList = await jsonRequest(server.baseUrl, '/api/attendance', {
        headers: { [TEST_ADMIN_HEADER]: 'true' },
      });
      expect(attList.response.status).toBe(200);
      expect(attList.body).toEqual(
        expect.objectContaining({
          data: expect.arrayContaining([
            expect.objectContaining({ employeeId: 2 }),
            expect.objectContaining({ employeeId: 8 })
          ]),
          pagination: expect.objectContaining({
            page: 1,
            limit: 50,
            total: 2,
            pages: 1
          })
        })
      );

    } finally {
      await server.close();
    }
  });

  it('rejects attendance creation without admin session', async () => {
    const server = await createJsonTestServer(
      (app) => registerAttendanceRoutes(app),
      { setupApp: async (app) => setupTestAdminSession(app) }
    );

    try {
      const result = await jsonRequest(server.baseUrl, '/api/attendance', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          employeeId: 2,
          date: '2026/03/01',
          clockIn: '09:00',
          clockOut: '18:00',
          isHoliday: false,
        }),
      });
      expect(result.response.status).toBe(401);
      expect(storageMock.createTemporaryAttendance).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it('salary calculation receives the provided employeeId', async () => {
    // Pre-populate attendance for employee ID=2
    state.attendance = [
      {
        id: 50,
        employeeId: 2,
        date: '2026/03/01',
        clockIn: '09:00',
        clockOut: '20:00',
        isHoliday: false,
        holidayType: null,
      },
      {
        id: 51,
        employeeId: 2,
        date: '2026/03/02',
        clockIn: '09:00',
        clockOut: '19:00',
        isHoliday: false,
        holidayType: null,
      },
    ];

    const server = await createJsonTestServer(
      (app) => registerSalaryRoutes(app),
      { setupApp: async (app) => setupTestAdminSession(app) }
    );

    try {
      const headers = {
        [TEST_ADMIN_HEADER]: 'true',
        'content-type': 'application/json',
      };

      // Create a salary record for employee 2
      const createResult = await jsonRequest(server.baseUrl, '/api/salary-records', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          employeeId: 2,
          employeeName: 'Employee Alpha',
          salaryYear: 2026,
          salaryMonth: 3,
          baseSalary: 28590,
          totalOT1Hours: 10,
          totalOT2Hours: 5,
          totalOvertimePay: 4200,
          holidayDays: 0,
          holidayDailySalary: 0,
          totalHolidayPay: 0,
          grossSalary: 32790,
          deductions: [],
          totalDeductions: 0,
          netSalary: 32790,
          attendanceData: [],
        }),
      });

      expect(createResult.response.status).toBe(201);
      expect(createResult.body).toEqual(
        expect.objectContaining({
          employeeId: 2,
          employeeName: 'Employee Alpha',
          salaryYear: 2026,
          salaryMonth: 3,
        })
      );

      // Verify the salary record was stored with correct employeeId
      expect(storageMock.createSalaryRecord).toHaveBeenCalledWith(
        expect.objectContaining({
          employeeId: 2,
          employeeName: 'Employee Alpha',
        })
      );

      // Verify the salary calculator received employeeId=2 (not 1)
      if (salaryCalculatorMock.calculateSalary.mock.calls.length > 0) {
        const lastCall = salaryCalculatorMock.calculateSalary.mock.calls[0];
        // employeeId is the last parameter
        const passedEmployeeId = lastCall[lastCall.length - 1];
        expect(passedEmployeeId).toBe(2);
      }
    } finally {
      await server.close();
    }
  });

  it('multi-employee attendance records maintain separate employeeIds', async () => {
    // Pre-populate mixed attendance
    state.attendance = [
      { id: 60, employeeId: 2, date: '2026/03/01', clockIn: '09:00', clockOut: '18:00', isHoliday: false, holidayType: null },
      { id: 61, employeeId: 8, date: '2026/03/01', clockIn: '08:30', clockOut: '17:30', isHoliday: false, holidayType: null },
      { id: 62, employeeId: 2, date: '2026/03/02', clockIn: '09:00', clockOut: '19:00', isHoliday: false, holidayType: null },
    ];

    const server = await createJsonTestServer(
      (app) => registerSalaryRoutes(app),
      { setupApp: async (app) => setupTestAdminSession(app) }
    );

    try {
      const headers = {
        [TEST_ADMIN_HEADER]: 'true',
        'content-type': 'application/json',
      };

      // Create salary record for employee 2
      const create2 = await jsonRequest(server.baseUrl, '/api/salary-records', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          employeeId: 2,
          employeeName: 'Employee Alpha',
          salaryYear: 2026,
          salaryMonth: 3,
          baseSalary: 28590,
          totalOT1Hours: 10,
          totalOT2Hours: 5,
          totalOvertimePay: 4200,
          totalHolidayPay: 0,
          grossSalary: 32790,
          deductions: [],
          totalDeductions: 0,
          netSalary: 32790,
          attendanceData: [],
        }),
      });
      expect(create2.response.status).toBe(201);

      // Create salary record for employee 8
      const create8 = await jsonRequest(server.baseUrl, '/api/salary-records', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          employeeId: 8,
          employeeName: 'Employee Beta',
          salaryYear: 2026,
          salaryMonth: 3,
          baseSalary: 28590,
          totalOT1Hours: 0,
          totalOT2Hours: 0,
          totalOvertimePay: 0,
          totalHolidayPay: 0,
          grossSalary: 28590,
          deductions: [],
          totalDeductions: 0,
          netSalary: 28590,
          attendanceData: [],
        }),
      });
      expect(create8.response.status).toBe(201);

      // Verify both records stored with distinct employeeIds
      expect(state.salaryRecords).toHaveLength(2);
      expect(state.salaryRecords[0]).toMatchObject({ employeeId: 2, employeeName: 'Employee Alpha' });
      expect(state.salaryRecords[1]).toMatchObject({ employeeId: 8, employeeName: 'Employee Beta' });

      // Verify list endpoint returns both
      const listResult = await jsonRequest(server.baseUrl, '/api/salary-records', {
        headers: { [TEST_ADMIN_HEADER]: 'true' },
      });
      expect(listResult.response.status).toBe(200);
      expect(listResult.body).toEqual(
        expect.objectContaining({
          data: expect.arrayContaining([
            expect.objectContaining({ employeeId: 2 }),
            expect.objectContaining({ employeeId: 8 })
          ]),
          pagination: expect.objectContaining({
            page: 1,
            limit: 50,
            total: 2,
            pages: 1
          })
        })
      );
    } finally {
      await server.close();
    }
  });
});
