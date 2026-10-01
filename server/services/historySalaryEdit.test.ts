import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { InsertSalaryRecord, SalaryRecord } from '@shared/schema';
import { PayrollCorrectionError } from './payrollCorrection';

const currentData = vi.hoisted(() => ({
  getSettings: vi.fn(() => { throw new Error('Historical edits must not read current settings.'); }),
  getTemporaryAttendanceByEmployeeAndMonth: vi.fn(() => { throw new Error('Historical edits must not read current attendance.'); }),
}));
vi.mock('../storage', () => ({ storage: currentData }));

import { buildHistorySalaryEdit } from './historySalaryEdit';

function salary(): SalaryRecord {
  return {
    id: 7, revision: 3, salaryYear: 2026, salaryMonth: 9, employeeId: 42,
    employeeName: 'Synthetic employee', baseSalary: 30000, holidayCalculationBaseSalary: 30000, housingAllowance: 100, welfareAllowance: 200,
    allowances: [{ name: 'Synthetic allowance', amount: 200 }], totalOT1Hours: 1, totalOT2Hours: 0,
    totalOvertimePay: 300, holidayDays: 1, holidayDailySalary: 1000, totalHolidayPay: 1000,
    grossSalary: 31600, deductions: [{ name: 'Synthetic withholding', amount: 1000 }],
    totalDeductions: 1000, netSalary: 30600, attendanceData: [{
      id: 1, employeeId: 42, date: '2026-09-24', clockIn: '08:00', clockOut: '17:00',
      isHoliday: false, holidayType: null, holidayId: null, isBarcodeScanned: false, createdAt: null,
    }], specialLeaveInfo: null, anonymizedAt: null, retentionUntil: null, employeeSnapshot: null,
    createdAt: new Date('2026-10-01T00:00:00Z'),
  };
}

function expectError(run: () => unknown, code: string, status = 400) {
  try {
    run(); expect.fail('Expected edit to be rejected');
  } catch (error) {
    expect(error).toBeInstanceOf(PayrollCorrectionError);
    expect((error as PayrollCorrectionError).code).toBe(code);
    expect((error as PayrollCorrectionError).status).toBe(status);
  }
}

beforeEach(() => vi.clearAllMocks());

describe('audited manual history salary edit calculations', () => {
  it('calculates financial inputs on the server while preserving original overtime, holiday pay and archived attendance', () => {
    const original = salary();
    const unchanged = structuredClone(original);
    const input: Partial<InsertSalaryRecord> = {
      baseSalary: 31000, housingAllowance: 200,
      allowances: [{ name: 'Synthetic revised allowance', amount: 300 }],
      deductions: [{ name: 'Synthetic revised withholding', amount: 500 }],
      specialLeaveInfo: { usedDays: 0, usedDates: [], cashDays: 1, cashAmount: 1200 },
      totalOvertimePay: 999999, totalOT1Hours: 999, totalOT2Hours: 999,
      totalHolidayPay: 999999, holidayDays: 999, welfareAllowance: 999999, grossSalary: 1, netSalary: 1,
    };
    const preview = buildHistorySalaryEdit(original, input, 'Correct synthetic manual inputs', 'paid_adjustment');
    expect(preview.after).toMatchObject({
      baseSalary: 31000, holidayCalculationBaseSalary: 30000, housingAllowance: 200, welfareAllowance: 300, totalDeductions: 500,
      totalOT1Hours: 1, totalOT2Hours: 0, totalOvertimePay: 300, totalHolidayPay: 1000,
      holidayDays: 1, grossSalary: 34000, netSalary: 33500,
    });
    expect(preview.delta).toEqual({ grossSalary: 2400, totalDeductions: -500, netSalary: 2900, totalHolidayPay: 0, holidayDays: 0 });
    expect(preview.after.attendanceData).toEqual(original.attendanceData);
    expect(preview.revision).toBe(3);
    expect(preview.paymentHandling).toBe('paid_adjustment');
    expect(original).toEqual(unchanged);
    expect(currentData.getSettings).not.toHaveBeenCalled();
    expect(currentData.getTemporaryAttendanceByEmployeeAndMonth).not.toHaveBeenCalled();
  });

  it('preserves legacy welfare allowance when a base-only edit has no allowance rows', () => {
    const original = salary();
    original.allowances = [];
    original.welfareAllowance = 500;
    original.grossSalary += 300;
    original.netSalary += 300;
    const preview = buildHistorySalaryEdit(original, { baseSalary: 31000 }, 'Correct synthetic base salary', 'unpaid');
    expect(preview.after.allowances).toEqual([]);
    expect(preview.after.welfareAllowance).toBe(500);
    expect(preview.after.grossSalary).toBe(32900);
    expect(preview.after.netSalary).toBe(31900);
    expect(preview.delta).toEqual({ grossSalary: 1000, totalDeductions: 0, netSalary: 1000, totalHolidayPay: 0, holidayDays: 0 });
    expect(currentData.getSettings).not.toHaveBeenCalled();
    expect(currentData.getTemporaryAttendanceByEmployeeAndMonth).not.toHaveBeenCalled();
  });

  it('preserves the original calculation when no manual inputs change', () => {
    const original = salary();
    const preview = buildHistorySalaryEdit(original, {}, 'Review synthetic record', 'unknown_adjustment');
    expect(preview.after).toEqual(original);
    expect(preview.delta).toEqual({ grossSalary: 0, totalDeductions: 0, netSalary: 0, totalHolidayPay: 0, holidayDays: 0 });
    expect(preview.holidays).toEqual([]);
  });

  it.each([
    { employeeId: 43 }, { employeeName: 'Different synthetic employee' }, { salaryYear: 2025 },
    { salaryMonth: 10 }, { attendanceData: [] },
  ])('rejects changing immutable employee, month or attendance fields: %o', (input) => {
    expectError(() => buildHistorySalaryEdit(salary(), input, 'Synthetic edit', 'unpaid'), 'IMMUTABLE_SALARY_SCOPE');
  });

  it('accepts unchanged immutable snapshots without modifying them', () => {
    const original = salary();
    const preview = buildHistorySalaryEdit(original, {
      employeeId: original.employeeId, employeeName: original.employeeName,
      salaryYear: original.salaryYear, salaryMonth: original.salaryMonth,
      attendanceData: structuredClone(original.attendanceData),
    }, 'Synthetic edit', 'unpaid');
    expect(preview.after).toEqual(original);
  });

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])('rejects invalid monetary input %s', (baseSalary) => {
    expectError(() => buildHistorySalaryEdit(salary(), { baseSalary }, 'Synthetic edit', 'unpaid'), 'INVALID_SALARY_AMOUNT');
  });

  it('rejects overflowing combined amounts and invalid deduction amounts', () => {
    expectError(() => buildHistorySalaryEdit(salary(), {
      baseSalary: Number.MAX_VALUE, housingAllowance: Number.MAX_VALUE,
    }, 'Synthetic edit', 'unpaid'), 'INVALID_SALARY_AMOUNT');
    expectError(() => buildHistorySalaryEdit(salary(), {
      deductions: [{ name: 'Synthetic invalid deduction', amount: -1 }],
    }, 'Synthetic edit', 'unpaid'), 'INVALID_SALARY_AMOUNT');
  });

  it('rejects unidentified and anonymized salary records', () => {
    const missing = salary(); missing.employeeId = null;
    expectError(() => buildHistorySalaryEdit(missing, {}, 'Synthetic edit', 'unpaid'), 'INAPPLICABLE_SALARY_RECORD', 409);
    const anonymized = salary(); anonymized.anonymizedAt = new Date();
    expectError(() => buildHistorySalaryEdit(anonymized, {}, 'Synthetic edit', 'unpaid'), 'INAPPLICABLE_SALARY_RECORD', 409);
  });
});
