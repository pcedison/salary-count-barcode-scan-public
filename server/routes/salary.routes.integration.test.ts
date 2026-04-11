import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createJsonTestServer, jsonRequest } from '../test-utils/http-test-server';
import { TEST_ADMIN_HEADER, setupTestAdminSession } from '../test-utils/admin-test-session';

const salaryState = vi.hoisted(() => ({
  records: [
    {
      id: 7,
      salaryYear: 2026,
      salaryMonth: 3,
      employeeId: 5,
      employeeName: 'Employee Alpha',
      baseSalary: 30000,
      housingAllowance: 0,
      welfareAllowance: 500,
      totalOT1Hours: 2,
      totalOT2Hours: 1,
      totalOvertimePay: 800,
      holidayDays: 0,
      holidayDailySalary: 0,
      totalHolidayPay: 0,
      grossSalary: 31300,
      deductions: [],
      totalDeductions: 0,
      netSalary: 31300,
      attendanceData: [],
      createdAt: new Date('2026-03-12T00:00:00.000Z')
    }
  ] as Array<Record<string, unknown>>,
  settings: {
    id: 1,
    baseHourlyRate: 119,
    ot1Multiplier: 1.34,
    ot2Multiplier: 1.67,
    baseMonthSalary: 28590,
    welfareAllowance: 500,
    deductions: [],
    allowances: [],
    adminPin: '123456'
  } as Record<string, unknown>,
  lastUpdate: null as null | { id: number; data: Record<string, unknown> }
}));

const salaryCalculatorMock = vi.hoisted(() => ({
  calculateSalary: vi.fn(() => ({
    totalOT1Hours: 4,
    totalOT2Hours: 2,
    totalOvertimePay: 1666,
    grossSalary: 33256,
    netSalary: 32856
  })),
  calculateHolidayPayAdjustments: vi.fn(() => ({
    sickLeaveDays: 1,
    sickLeaveDeduction: 300,
    personalLeaveDays: 0,
    personalLeaveDeduction: 0,
    typhoonLeaveDays: 0,
    typhoonLeaveDeduction: 0,
    workedHolidayDays: 1,
    workedHolidayPay: 200,
    deductionItems: [{ name: '病假扣款', amount: 300 }]
  })),
  calculateOvertimePay: vi.fn(() => 1234)
}));

const storageMock = vi.hoisted(() => ({
  getAllSalaryRecords: vi.fn(async () => salaryState.records),
  getAllSalaryRecordsPage: vi.fn(async (page: number, limit: number) => ({
    rows: salaryState.records.slice(0, limit),
    total: salaryState.records.length,
    page,
    limit
  })),
  getSalaryRecordById: vi.fn(async (id: number) =>
    salaryState.records.find((record) => record.id === id)
  ),
  getSettings: vi.fn(async () => salaryState.settings),
  getTemporaryAttendance: vi.fn(async () => []),
  getTemporaryAttendanceByEmployeeAndMonth: vi.fn(async () => []),
  updateSalaryRecord: vi.fn(async (id: number, data: Record<string, unknown>) => {
    salaryState.lastUpdate = { id, data };
    const record = salaryState.records.find((item) => item.id === id);

    if (!record) {
      return undefined;
    }

    Object.assign(record, data);
    return record;
  })
}));

vi.mock('../storage', () => ({
  storage: storageMock
}));

vi.mock('../utils/salaryCalculator', () => salaryCalculatorMock);

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

let registerSalaryRoutes: typeof import('./salary.routes').registerSalaryRoutes;

beforeAll(async () => {
  ({ registerSalaryRoutes } = await import('./salary.routes'));
});

beforeEach(() => {
  salaryState.records = [
    {
      id: 7,
      salaryYear: 2026,
      salaryMonth: 3,
      employeeId: 5,
      employeeName: 'Employee Alpha',
      baseSalary: 30000,
      housingAllowance: 0,
      welfareAllowance: 500,
      totalOT1Hours: 2,
      totalOT2Hours: 1,
      totalOvertimePay: 800,
      holidayDays: 0,
      holidayDailySalary: 0,
      totalHolidayPay: 0,
      grossSalary: 31300,
      deductions: [],
      totalDeductions: 0,
      netSalary: 31300,
      attendanceData: [],
      createdAt: new Date('2026-03-12T00:00:00.000Z')
    }
  ];
  salaryState.settings = {
    id: 1,
    baseHourlyRate: 119,
    ot1Multiplier: 1.34,
    ot2Multiplier: 1.67,
    baseMonthSalary: 28590,
    welfareAllowance: 500,
    deductions: [],
    allowances: [],
    adminPin: '123456'
  };
  salaryState.lastUpdate = null;
  vi.clearAllMocks();
});

describe('salary routes integration', () => {
  it('requires admin authorization for salary record reads and debug endpoints', async () => {
    const server = await createJsonTestServer(registerSalaryRoutes, {
      setupApp: async (app) => {
        setupTestAdminSession(app);
      }
    });

    try {
      const endpoints = [
        { path: '/api/salary-records', method: 'GET' },
        { path: '/api/salary-records/7', method: 'GET' },
        { path: '/api/salary-records/7/pdf', method: 'GET' },
        { path: '/api/test-salary-calculation', method: 'GET' }
      ];

      for (const endpoint of endpoints) {
        const result = await jsonRequest<{ success: boolean; message: string }>(
          server.baseUrl,
          endpoint.path,
          {
            method: endpoint.method,
            redirect: 'manual'
          }
        );

        expect(result.response.status).toBe(401);
      }
    } finally {
      await server.close();
    }
  });

  it('returns salary data and print redirect for authorized admin requests', async () => {
    const server = await createJsonTestServer(registerSalaryRoutes, {
      setupApp: async (app) => {
        setupTestAdminSession(app);
      }
    });

    try {
      const headers = {
        [TEST_ADMIN_HEADER]: 'true'
      };

      const listResult = await jsonRequest<{
        data: Array<Record<string, unknown>>;
        pagination: { page: number; limit: number; total: number; pages: number };
      }>(
        server.baseUrl,
        '/api/salary-records',
        { headers }
      );
      expect(listResult.response.status).toBe(200);
      expect(listResult.body).toEqual({
        data: [
          expect.objectContaining({
            id: 7,
            employeeName: 'Employee Alpha',
            netSalary: 31300
          })
        ],
        pagination: {
          page: 1,
          limit: 50,
          total: 1,
          pages: 1
        }
      });
      expect(storageMock.getAllSalaryRecordsPage).toHaveBeenCalledWith(1, 50);
      expect(storageMock.getAllSalaryRecords).not.toHaveBeenCalled();

      const detailResult = await jsonRequest<Record<string, unknown>>(
        server.baseUrl,
        '/api/salary-records/7',
        { headers }
      );
      expect(detailResult.response.status).toBe(200);
      expect(detailResult.body).toEqual(
        expect.objectContaining({
          id: 7,
          salaryYear: 2026,
          salaryMonth: 3
        })
      );

      const pdfResult = await jsonRequest<null>(
        server.baseUrl,
        '/api/salary-records/7/pdf',
        {
          headers,
          redirect: 'manual'
        }
      );
      expect(pdfResult.response.status).toBe(302);
      expect(pdfResult.response.headers.get('location')).toBe('/print-salary?id=7');
    } finally {
      await server.close();
    }
  });

  it('does not expose the salary calculation debug route in production mode', async () => {
    const originalNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    let server: Awaited<ReturnType<typeof createJsonTestServer>> | undefined;
    try {
      server = await createJsonTestServer(registerSalaryRoutes);

      const result = await jsonRequest<{ success: boolean; message: string }>(server.baseUrl, '/api/test-salary-calculation');

      expect(result.response.status).toBe(404);
    } finally {
      if (server) {
        await server.close();
      }
      process.env.NODE_ENV = originalNodeEnv;
    }
  });

  it('preserves manually edited salary values when history editing forces an update', async () => {
    const server = await createJsonTestServer(registerSalaryRoutes, {
      setupApp: async (app) => {
        setupTestAdminSession(app);
      }
    });

    try {
      const headers = {
        [TEST_ADMIN_HEADER]: 'true',
        'content-type': 'application/json',
        'x-force-update': 'true'
      };

      const patchResult = await jsonRequest<Record<string, unknown>>(
        server.baseUrl,
        '/api/salary-records/7',
        {
          method: 'PATCH',
          headers,
          body: JSON.stringify({
            baseSalary: 31000,
            totalOT1Hours: 9,
            totalOT2Hours: 4,
            totalOvertimePay: 2500,
            grossSalary: 34500,
            deductions: [{ name: '手動扣款', amount: 500 }],
            totalDeductions: 500,
            totalHolidayPay: 700,
            netSalary: 34000
          })
        }
      );

      expect(patchResult.response.status).toBe(200);
      expect(patchResult.body).toEqual(
        expect.objectContaining({
          id: 7,
          baseSalary: 31000,
          totalOT1Hours: 9,
          totalOT2Hours: 4,
          totalOvertimePay: 2500,
          grossSalary: 34500,
          totalDeductions: 500,
          totalHolidayPay: 700,
          netSalary: 34000
        })
      );
      expect(storageMock.getTemporaryAttendance).not.toHaveBeenCalled();
      expect(salaryCalculatorMock.calculateSalary).not.toHaveBeenCalled();
      expect(storageMock.updateSalaryRecord).toHaveBeenCalledWith(
        7,
        expect.objectContaining({
          baseSalary: 31000,
          totalOT1Hours: 9,
          totalOT2Hours: 4,
          totalOvertimePay: 2500,
          grossSalary: 34500,
          totalDeductions: 500,
          totalHolidayPay: 700,
          netSalary: 34000
        })
      );
    } finally {
      await server.close();
    }
  });

  it('recalculates salary totals for non-forced history edits before persisting', async () => {
    const server = await createJsonTestServer(registerSalaryRoutes, {
      setupApp: async (app) => {
        setupTestAdminSession(app);
      }
    });

    try {
      const headers = {
        [TEST_ADMIN_HEADER]: 'true',
        'content-type': 'application/json'
      };

      const patchResult = await jsonRequest<Record<string, unknown>>(
        server.baseUrl,
        '/api/salary-records/7',
        {
          method: 'PATCH',
          headers,
          body: JSON.stringify({
            baseSalary: 31000,
            totalOT1Hours: 12,
            totalOT2Hours: 6,
            deductions: [{ name: '自訂扣款', amount: 100 }],
            totalHolidayPay: 400
          })
        }
      );

      expect(patchResult.response.status).toBe(200);
      expect(storageMock.getTemporaryAttendanceByEmployeeAndMonth).toHaveBeenCalledWith(5, 2026, 3);
      expect(salaryCalculatorMock.calculateHolidayPayAdjustments).toHaveBeenCalled();
      expect(salaryCalculatorMock.calculateSalary).toHaveBeenCalledWith(
        2026,
        3,
        { totalOT1Hours: 12, totalOT2Hours: 6 },
        31000,
        400,
        expect.objectContaining({
          baseHourlyRate: 119,
          ot1Multiplier: 1.34,
          ot2Multiplier: 1.67,
          baseMonthSalary: 28590,
          welfareAllowance: 500
        }),
        600,
        500,
        0,
        5
      );
      expect(storageMock.updateSalaryRecord).toHaveBeenCalledWith(
        7,
        expect.objectContaining({
          baseSalary: 31000,
          totalOT1Hours: 4,
          totalOT2Hours: 2,
          totalOvertimePay: 1666,
          totalHolidayPay: 600,
          grossSalary: 33256,
          totalDeductions: 400,
          netSalary: 32856,
          deductions: [
            { name: '自訂扣款', amount: 100 },
            { name: '病假扣款', amount: 300 }
          ]
        })
      );
      expect(patchResult.body).toEqual(
        expect.objectContaining({
          id: 7,
          totalOT1Hours: 4,
          totalOT2Hours: 2,
          totalOvertimePay: 1666,
          totalHolidayPay: 600,
          grossSalary: 33256,
          totalDeductions: 400,
          netSalary: 32856
        })
      );
    } finally {
      await server.close();
    }
  });
});
