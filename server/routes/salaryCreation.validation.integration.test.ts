import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createJsonTestServer, jsonRequest } from '../test-utils/http-test-server';
import { TEST_ADMIN_HEADER, setupTestAdminSession } from '../test-utils/admin-test-session';
import type { InsertSalaryRecord, Settings, TemporaryAttendance } from '@shared/schema';
import { calculateDailyOvertimeSummary, calculateOvertime } from '@shared/utils/salaryMath';
import { calculateHolidayPayAdjustments } from '../utils/salaryCalculator';

const storageMock = vi.hoisted(() => ({
  getSettings: vi.fn(async () => ({
    id: 1, baseHourlyRate: 100, ot1Multiplier: 1.5, ot2Multiplier: 2,
    baseMonthSalary: 30000, welfareAllowance: 0, deductions: [], allowances: [],
    adminPin: 'synthetic-only', barcodeEnabled: true, updatedAt: null,
  })),
  getTemporaryAttendanceByEmployeeAndMonth: vi.fn(async (): Promise<TemporaryAttendance[]> => []),
}));
const repositoryMock = vi.hoisted(() => ({
  createSalaryRecord: vi.fn(async (record) => ({ ...record, id: 7, revision: 0 })),
}));
vi.mock('../storage', () => ({ storage: storageMock }));
vi.mock('../repositories/salaryRepository', () => ({ salaryRepository: repositoryMock }));

let registerSalaryRoutes: typeof import('./salary.routes').registerSalaryRoutes;
let buildCalculatedSalaryRecord: typeof import('./salary.routes').buildCalculatedSalaryRecord;
beforeAll(async () => { ({ registerSalaryRoutes, buildCalculatedSalaryRecord } = await import('./salary.routes')); });
beforeEach(() => {
  vi.clearAllMocks();
  storageMock.getTemporaryAttendanceByEmployeeAndMonth.mockReset().mockResolvedValue([]);
});

function draft() {
  return {
    salaryYear: 2026, salaryMonth: 9, employeeId: 7, employeeName: 'Synthetic employee',
    baseSalary: 30000, housingAllowance: 0, welfareAllowance: 500,
    totalOT1Hours: 2, totalOT2Hours: 1, totalHolidayPay: 0,
    grossSalary: 1, netSalary: 1, deductions: [], allowances: [], attendanceData: [],
  };
}

async function postSalary(input: Record<string, unknown>, authorized = true) {
  const server = await createJsonTestServer(registerSalaryRoutes, {
    setupApp: (app) => setupTestAdminSession(app),
  });
  try {
    return await jsonRequest<Record<string, unknown>>(server.baseUrl, '/api/salary-records', {
      method: 'POST', headers: {
        'content-type': 'application/json', ...(authorized ? { [TEST_ADMIN_HEADER]: 'true' } : {}),
      }, body: JSON.stringify(input),
    });
  } finally { await server.close(); }
}

describe('new salary settlement input validation with the real calculator', () => {
  it('recalculates valid salary inputs and permits a negative net balance after valid deductions', async () => {
    const result = await postSalary({ ...draft(), deductions: [{ name: 'Synthetic deduction', amount: 32000 }] });
    expect(result.response.status).toBe(201);
    expect(result.body).toMatchObject({ totalOvertimePay: 500, grossSalary: 31000, totalDeductions: 32000, netSalary: -1000 });
    expect(repositoryMock.createSalaryRecord).toHaveBeenCalledOnce();
  });

  it('rejects anonymous creation before reading or writing salary data', async () => {
    expect((await postSalary(draft(), false)).response.status).toBe(401);
    expect(storageMock.getSettings).not.toHaveBeenCalled();
    expect(repositoryMock.createSalaryRecord).not.toHaveBeenCalled();
  });

  it('preserves valid zero, nullable amounts, decimal items and special-leave metadata', async () => {
    const result = await postSalary({
      ...draft(), baseSalary: 0, housingAllowance: null, welfareAllowance: 0, totalHolidayPay: null,
      totalOT1Hours: 0, totalOT2Hours: 0,
      deductions: [{ name: 'Synthetic deduction', amount: 0.25, description: null }],
      allowances: [{ name: 'Synthetic allowance', amount: 0, description: 'Synthetic note' }],
      specialLeaveInfo: { usedDays: 0, usedDates: [], cashDays: 0.5, cashAmount: 50.25, notes: 'Synthetic note' },
    });
    expect(result.response.status).toBe(201);
    expect(result.body).toMatchObject({ grossSalary: 50.25, totalDeductions: 0.25, netSalary: 50 });
    expect(result.body?.specialLeaveInfo).toEqual({ usedDays: 0, usedDates: [], cashDays: 0.5, cashAmount: 50.25, notes: 'Synthetic note' });
  });

  it.each([
    { baseSalary: -1 },
    { housingAllowance: -1 },
    { welfareAllowance: -1 },
    { totalOT1Hours: -1 },
    { totalOT2Hours: -1 },
    { totalHolidayPay: -1 },
    { salaryMonth: 0 },
    { salaryMonth: 13 },
    { salaryYear: 10000 },
    { employeeId: -1 },
    { deductions: [{ name: 'Synthetic negative deduction', amount: -100 }] },
    { deductions: [{ name: 'Synthetic text amount', amount: '100' }] },
    { deductions: [null] },
    { deductions: { name: 'Synthetic non-array', amount: 100 } },
    { allowances: [{ name: 'Synthetic negative allowance', amount: -100 }] },
    { allowances: [{ name: 'Synthetic text amount', amount: '100' }] },
    { specialLeaveInfo: { usedDays: 0, usedDates: [], cashDays: 1, cashAmount: -100 } },
    { specialLeaveInfo: { usedDays: 0, usedDates: [], cashDays: 1, cashAmount: '100' } },
    { specialLeaveInfo: { usedDays: 0, usedDates: [], cashDays: 1 } },
    { deductions: Array.from({ length: 101 }, () => ({ name: 'Synthetic deduction', amount: 1 })) },
    { allowances: [{ name: ' ', amount: 1 }] },
    { allowances: [{ name: 'Synthetic allowance', amount: 1, description: {} }] },
  ])('rejects malformed or negative input without storing a salary: %j', async (invalidFields) => {
    const result = await postSalary({ ...draft(), ...invalidFields });
    expect(result.response.status, JSON.stringify({ deductions: result.body?.totalDeductions, net: result.body?.netSalary })).toBe(400);
    expect(storageMock.getSettings).not.toHaveBeenCalled();
    expect(repositoryMock.createSalaryRecord).not.toHaveBeenCalled();
  });

  it('preserves rejection of numeric inputs outside the supported storage range', async () => {
    const result = await postSalary({ ...draft(), totalOT1Hours: 1e308 });
    expect(result.response.status).toBe(400);
    expect(repositoryMock.createSalaryRecord).not.toHaveBeenCalled();
  });

  it.each([
    { totalOT1Hours: Number.MAX_SAFE_INTEGER },
    { specialLeaveInfo: { usedDays: 0, usedDates: [], cashDays: 1, cashAmount: 1e308 } },
  ])('rejects calculated totals outside the supported storage range: %j', async (fields) => {
    const result = await postSalary({ ...draft(), ...fields });
    expect(result.response.status).toBe(400);
    expect(repositoryMock.createSalaryRecord).not.toHaveBeenCalled();
  });

  it('calculates leave deductions only from the submitted settlement snapshot', async () => {
    const selected: TemporaryAttendance = {
      id: 1, employeeId: 7, date: '2026/09/01', clockIn: '08:00', clockOut: '16:00',
      isHoliday: false, isBarcodeScanned: false, holidayId: null, holidayType: null, createdAt: null,
    };
    const unrelated = { ...selected, id: 2, date: '2026/09/02', clockIn: '--:--', clockOut: '--:--', isHoliday: true, holidayType: 'sick_leave' };
    storageMock.getTemporaryAttendanceByEmployeeAndMonth.mockResolvedValueOnce([selected, unrelated]);
    const result = await postSalary({ ...draft(), attendanceData: [selected] });
    expect(result.response.status).toBe(201);
    expect(result.body, JSON.stringify({ deductions: result.body?.totalDeductions, net: result.body?.netSalary })).toMatchObject({ totalDeductions: 0, netSalary: 31000 });
    expect(result.body?.attendanceData).toEqual([selected]);
    expect(storageMock.getTemporaryAttendanceByEmployeeAndMonth).not.toHaveBeenCalled();
  });

  it('keeps the submitted leave snapshot when live attendance changes after preview', async () => {
    const selected: TemporaryAttendance = {
      id: 1, employeeId: 7, date: '2026/09/01', clockIn: '08:00', clockOut: '12:00',
      isHoliday: true, isBarcodeScanned: false, holidayId: null, holidayType: 'sick_leave', createdAt: null,
    };
    storageMock.getTemporaryAttendanceByEmployeeAndMonth.mockResolvedValueOnce([{ ...selected, clockIn: '--:--', clockOut: '--:--' }]);
    const result = await postSalary({ ...draft(), attendanceData: [selected] });
    expect(result.response.status).toBe(201);
    expect(result.body, JSON.stringify({ deductions: result.body?.totalDeductions, net: result.body?.netSalary })).toMatchObject({ totalDeductions: 250, netSalary: 30750 });
    expect(result.body?.attendanceData).toEqual([selected]);
  });

  it('does not add worked holiday pay a second time to the preview total', async () => {
    const selected: TemporaryAttendance = {
      id: 1, employeeId: 7, date: '2026/09/01', clockIn: '08:00', clockOut: '16:00',
      isHoliday: true, isBarcodeScanned: false, holidayId: null, holidayType: 'worked', createdAt: null,
    };
    storageMock.getTemporaryAttendanceByEmployeeAndMonth.mockResolvedValueOnce([selected]);
    const result = await postSalary({ ...draft(), totalHolidayPay: 1000, attendanceData: [selected] });
    expect(result.response.status).toBe(201);
    expect(result.body, JSON.stringify({ holidayPay: result.body?.totalHolidayPay, net: result.body?.netSalary })).toMatchObject({ totalHolidayPay: 1000, netSalary: 32000 });
  });

  it('keeps automation in its default mode where worked-holiday pay is added to the supplied base', async () => {
    const attendance: TemporaryAttendance[] = [{
      id: 1, employeeId: 7, date: '2026/09/01', clockIn: '08:00', clockOut: '16:00',
      isHoliday: true, isBarcodeScanned: false, holidayId: null, holidayType: 'worked', createdAt: null,
    }];
    const result = await buildCalculatedSalaryRecord({ ...draft(), totalHolidayPay: 0, attendanceData: attendance } as InsertSalaryRecord,
      await storageMock.getSettings() as Settings, { attendanceRecords: attendance });
    expect(result).toMatchObject({ totalHolidayPay: 1000, netSalary: 32000 });
  });

  it('preserves the legacy live-attendance fallback when an API caller omits its snapshot', async () => {
    storageMock.getTemporaryAttendanceByEmployeeAndMonth.mockResolvedValueOnce([{
      id: 1, employeeId: 7, date: '2026/09/01', clockIn: '--:--', clockOut: '--:--',
      isHoliday: true, isBarcodeScanned: false, holidayId: null, holidayType: 'sick_leave', createdAt: null,
    }]);
    const { attendanceData: _snapshot, ...input } = draft();
    const result = await postSalary(input);
    expect(result.response.status).toBe(201);
    expect(result.body).toMatchObject({ totalDeductions: 500, netSalary: 30500 });
    expect(storageMock.getTemporaryAttendanceByEmployeeAndMonth).toHaveBeenCalledExactlyOnceWith(7, 2026, 9);
  });

  it('rejects the same leave date under slash and hyphen spellings before double deduction', async () => {
    const row = { id: 1, employeeId: 7, date: '2026/9/1', clockIn: '--:--', clockOut: '--:--', isHoliday: true, holidayType: 'sick_leave' };
    const result = await postSalary({ ...draft(), attendanceData: [row, { ...row, id: 2, date: '2026-09-01' }] });
    expect(result.response.status, JSON.stringify({ deductions: result.body?.totalDeductions, net: result.body?.netSalary })).toBe(400);
    expect(repositoryMock.createSalaryRecord).not.toHaveBeenCalled();
  });

  it.each([
    { label: 'split shifts', clocks: [['08:00', '12:00'], ['13:00', '17:00']], ot1: 1, net: 30650 },
    { label: 'adjacent shifts', clocks: [['08:00', '12:00'], ['12:00', '17:00']], ot1: 1, net: 30650 },
    { label: 'cross-midnight shift and earlier shift in reverse order', clocks: [['18:00', '01:00'], ['08:00', '12:00']], ot1: 0, net: 30500 },
  ])('preserves the existing per-row preview totals for same-day $label', async ({ clocks, ot1, net }) => {
    const attendanceData = clocks.map(([clockIn, clockOut], index) => ({
      id: index + 1, employeeId: 7, date: index ? '2026-09-01' : '2026/9/1',
      clockIn, clockOut, isHoliday: false, holidayType: index ? 'none' : null,
    }));
    // This is the same per-row calculation used by useAttendanceData's preview.
    // Do not merge shifts or substitute a different daily overtime rule.
    const summaries = attendanceData.map(row => calculateDailyOvertimeSummary(row.clockIn, row.clockOut, {
      baseHourlyRate: 100, ot1Multiplier: 1.5, ot2Multiplier: 2,
    }));
    const totalOT1Hours = summaries.reduce((sum, row) => sum + row.ot1, 0);
    const totalOT2Hours = summaries.reduce((sum, row) => sum + row.ot2, 0);
    expect(totalOT1Hours).toBe(ot1);
    const result = await postSalary({ ...draft(), attendanceData, totalOT1Hours, totalOT2Hours });
    expect(result.response.status, JSON.stringify(result.body)).toBe(201);
    expect(result.body).toMatchObject({ totalOT1Hours: ot1, totalOT2Hours: 0,
      totalOvertimePay: summaries.reduce((sum, row) => sum + row.pay, 0),
      totalDeductions: 0, grossSalary: net, netSalary: net,
    });
    // Archived daily-hour evidence still conservatively declines multiple rows
    // on a date. Successful settlement must preserve the selected rows as-is.
    expect(result.body?.attendanceData).toEqual(attendanceData);
    expect(storageMock.getTemporaryAttendanceByEmployeeAndMonth).not.toHaveBeenCalled();
    expect(repositoryMock.createSalaryRecord).toHaveBeenCalledOnce();
  });

  it.each([
    { label: 'copied work rows with normalized dates and clocks', second: { clockIn: '8:00', clockOut: '12:00' } },
    { label: 'overlapping shifts', second: { clockIn: '11:00', clockOut: '17:00' } },
    { label: 'incomplete second shift', second: { clockIn: '13:00', clockOut: '' } },
    { label: 'zero-duration second shift', second: { clockIn: '13:00', clockOut: '13:00' } },
    { label: 'work mixed with full sick leave', second: { clockIn: '--:--', clockOut: '--:--', isHoliday: true, holidayType: 'sick_leave' } },
    { label: 'work mixed with partial sick leave', second: { clockIn: '13:00', clockOut: '17:00', isHoliday: true, holidayType: 'sick_leave' } },
    { label: 'work mixed with personal leave', second: { clockIn: '13:00', clockOut: '17:00', isHoliday: true, holidayType: 'personal_leave' } },
    { label: 'work mixed with leave despite a false holiday flag', second: { clockIn: '13:00', clockOut: '17:00', isHoliday: false, holidayType: 'sick_leave' } },
    { label: 'work mixed with an unclassified holiday flag', second: { clockIn: '13:00', clockOut: '17:00', isHoliday: true, holidayType: null } },
  ])('rejects ambiguous same-day $label before calculation or storage', async ({ second }) => {
    const first = { id: 1, employeeId: 7, date: '2026/9/1', clockIn: '08:00', clockOut: '12:00', isHoliday: false, holidayType: null };
    const result = await postSalary({ ...draft(), attendanceData: [first, { ...first, id: 2, date: '2026-09-01', ...second }] });
    expect(result.response.status).toBe(400);
    expect(storageMock.getSettings).not.toHaveBeenCalled();
    expect(repositoryMock.createSalaryRecord).not.toHaveBeenCalled();
  });

  it.each([
    { label: 'duplicate sick leave', types: ['sick_leave', 'sick_leave'], clocks: ['--:--', '--:--'], deduction: 1000, bonus: 0 },
    { label: 'conflicting leave categories', types: ['sick_leave', 'personal_leave'], clocks: ['--:--', '--:--'], deduction: 1500, bonus: 0 },
    { label: 'two worked-holiday rows', types: ['worked', 'worked'], clocks: ['08:00', '12:00'], deduction: 0, bonus: 2000 },
  ])('rejects same-day $label whose existing adjustments are counted per row', async ({ types, clocks, deduction, bonus }) => {
    const attendanceData = types.map((holidayType, index) => ({
      id: index + 1, employeeId: 7, date: index ? '2026-09-01' : '2026/9/1',
      clockIn: index && holidayType === 'worked' ? '13:00' : clocks[0],
      clockOut: index && holidayType === 'worked' ? '17:00' : clocks[1], isHoliday: true, holidayType,
    }));
    const adjustments = calculateHolidayPayAdjustments(attendanceData, 30000);
    expect(adjustments.deductionItems.reduce((sum, row) => sum + row.amount, 0)).toBe(deduction);
    expect(adjustments.workedHolidayPay).toBe(bonus);
    const result = await postSalary({ ...draft(), attendanceData, totalHolidayPay: bonus });
    expect(result.response.status).toBe(400);
    expect(storageMock.getSettings).not.toHaveBeenCalled();
    expect(repositoryMock.createSalaryRecord).not.toHaveBeenCalled();
  });

  it.each([{ year: 1900, status: 400 }, { year: 2000, status: 201 }])('validates the century leap-day boundary for $year', async ({ year, status }) => {
    const result = await postSalary({ ...draft(), salaryYear: year, salaryMonth: 2, totalOT1Hours: 0, totalOT2Hours: 0,
      attendanceData: [{ id: 1, employeeId: 7, date: `${year}/02/29`, clockIn: '08:00', clockOut: '16:00', isHoliday: false }],
    });
    expect(result.response.status).toBe(status);
    if (status === 400) expect(repositoryMock.createSalaryRecord).not.toHaveBeenCalled();
  });

  it('accepts valid cross-midnight clocks without changing the existing overtime rule', async () => {
    expect(calculateOvertime('18:00', '01:00')).toEqual({ total: 7, ot1: 0, ot2: 0 });
    const result = await postSalary({ ...draft(), totalOT1Hours: 0, totalOT2Hours: 0,
      attendanceData: [{ id: 1, employeeId: 7, date: '2026/09/01', clockIn: '18:00', clockOut: '01:00', isHoliday: false }],
    });
    expect(result.response.status).toBe(201);
    expect(result.body).toMatchObject({ totalOvertimePay: 0, grossSalary: 30500, netSalary: 30500,
      attendanceData: [{ clockIn: '18:00', clockOut: '01:00', overtimeHours: { ot1: 0, ot2: 0 } }],
    });
  });

  it.each([
    [null], { date: '2026/09/01' },
    [{ employeeId: 8, date: '2026/09/01', clockIn: '08:00', clockOut: '16:00' }],
    [{ employeeId: 7, date: '2026/10/01', clockIn: '08:00', clockOut: '16:00' }],
    [{ employeeId: 7, date: '2026/09/31', clockIn: '08:00', clockOut: '16:00' }],
    [{ employeeId: 7, date: '2026/09/01', clockIn: '25:00', clockOut: '16:00' }],
    [{ employeeId: 7, date: '2026/09/01', clockIn: '08:00', clockOut: {} }],
  ].map(attendanceData => ({ attendanceData })))('rejects malformed, cross-month or cross-employee settlement snapshots: %j', async ({ attendanceData }) => {
    const result = await postSalary({ ...draft(), attendanceData });
    expect(result.response.status).toBe(400);
    expect(storageMock.getSettings).not.toHaveBeenCalled();
    expect(repositoryMock.createSalaryRecord).not.toHaveBeenCalled();
  });
});
