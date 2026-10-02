import { describe, expect, it } from 'vitest';
import type { SalaryRecord, TemporaryAttendance } from '@shared/schema';
import type { PayrollCorrectionRequest } from '@shared/payrollCorrection';
import { calculateHolidayPayAdjustments } from '../utils/salaryCalculator';
import { buildPayrollHolidayCorrection, PayrollCorrectionError } from './payrollCorrection';
import { buildHistorySalaryEdit } from './historySalaryEdit';
import { validateAttendanceImportRow } from '../routes/import-helpers';

function row(date: string, holidayType: string | null = null, clockIn = '08:00', clockOut = '17:00'): TemporaryAttendance {
  return { id: 1, employeeId: 42, date, clockIn, clockOut, holidayType, isHoliday: Boolean(holidayType),
    holidayId: null, isBarcodeScanned: false, createdAt: null };
}

function salary(attendance: TemporaryAttendance[] = []): SalaryRecord {
  const adjustments = calculateHolidayPayAdjustments(attendance.map((entry) => ({
    ...entry, employeeId: entry.employeeId ?? undefined, clockOut: entry.clockOut ?? undefined,
  })), 30000);
  const deductions = [{ name: 'Synthetic withholding', amount: 1000 }, ...adjustments.deductionItems];
  const totalDeductions = deductions.reduce((sum, item) => sum + item.amount, 0);
  const grossSalary = 30600 + adjustments.workedHolidayPay;
  return {
    id: 7, salaryYear: 2026, salaryMonth: 9, employeeId: 42, employeeName: 'Synthetic employee',
    baseSalary: 30000, holidayCalculationBaseSalary: null, housingAllowance: 100, welfareAllowance: 200,
    allowances: [{ name: 'Synthetic allowance', amount: 200 }], totalOT1Hours: 1, totalOT2Hours: 0,
    totalOvertimePay: 300, holidayDays: adjustments.workedHolidayDays, holidayDailySalary: 1000,
    totalHolidayPay: adjustments.workedHolidayPay, grossSalary, deductions, totalDeductions,
    netSalary: grossSalary - totalDeductions, attendanceData: attendance, specialLeaveInfo: null,
    anonymizedAt: null, retentionUntil: null, employeeSnapshot: null, createdAt: new Date('2026-10-01T00:00:00Z'),
  } as SalaryRecord;
}

function request(overrides: Partial<PayrollCorrectionRequest> = {}): PayrollCorrectionRequest {
  return { holidays: [
    { date: '2026-09-25', holidayType: 'national_holiday', name: 'Synthetic holiday A', mode: 'add' },
    { date: '2026-09-28', holidayType: 'national_holiday', name: 'Synthetic holiday B', mode: 'add' },
  ], reason: 'Add omitted holiday records', paymentHandling: 'unknown_adjustment', ...overrides };
}

function expectError(run: () => unknown, code: string, status = 409) {
  try {
    run();
    expect.fail('Expected correction to be rejected');
  } catch (error) {
    expect(error).toBeInstanceOf(PayrollCorrectionError);
    expect((error as PayrollCorrectionError).code).toBe(code);
    expect((error as PayrollCorrectionError).status).toBe(status);
  }
}

describe('public temporary-closure salary compatibility', () => {
  it('removes the public calculator closure deduction when replacing it with a national holiday', () => {
    const original = salary([row('2026/09/25', 'temporary_stop_work_and_classes', '--:--', '--:--')]);
    const preview = buildPayrollHolidayCorrection(original, request({ holidays: [
      { date: '2026-09-25', holidayType: 'national_holiday', name: 'Synthetic national holiday', mode: 'replace' },
    ] }));
    expect(preview.delta.totalDeductions).toBe(-1000);
    expect(preview.delta.netSalary).toBe(1000);
    expect(preview.after.deductions).toEqual([{ name: 'Synthetic withholding', amount: 1000 }]);
    expect(preview.after.grossSalary).toBe(original.grossSalary);
  });

  it('preserves a prior closure classification and deduction when adding an unrelated national holiday', () => {
    const original = salary([row('2026/09/24', 'temporary_stop_work_and_classes', '--:--', '--:--')]);
    const preview = buildPayrollHolidayCorrection(original, request());
    expect(preview.delta.netSalary).toBe(0);
    expect(preview.after.deductions).toEqual(original.deductions);
    expect(preview.after.attendanceData?.[0].holidayType).toBe('temporary_stop_work_and_classes');
  });

  it('applies the existing public closure rule to a new absent holiday and accepts its CSV row', () => {
    const preview = buildPayrollHolidayCorrection(salary(), request({ holidays: [
      { date: '2026-09-25', holidayType: 'temporary_stop_work_and_classes', name: 'Synthetic closure', mode: 'add' },
    ] }));
    expect(preview.delta.totalDeductions).toBe(1000);
    expect(preview.delta.netSalary).toBe(-1000);
    expect(() => validateAttendanceImportRow({ date: '2026/09/25', clockIn: '--:--', clockOut: '--:--',
      isHoliday: true, holidayType: 'temporary_stop_work_and_classes' })).not.toThrow();
  });
});

describe('snapshot payroll holiday corrections', () => {
  it.each(['8:00', '08:00'])('corrects an imported genuine worked holiday with %s and preserves its source clocks', (clockIn) => {
    const imported = validateAttendanceImportRow({ date: '2026/09/25', clockIn, clockOut: '17:00', isHoliday: false });
    const original = salary([row(imported.date, null, imported.clockIn, imported.clockOut)]);
    const before = structuredClone(original);
    const preview = buildPayrollHolidayCorrection(original, request({ holidays: [
      { date: '2026-09-25', holidayType: 'worked', name: 'Synthetic worked holiday', mode: 'replace' },
    ] }));
    expect(preview.delta.netSalary).toBe(1000);
    expect(preview.after.attendanceData?.[0].clockIn).toBe(clockIn);
    expect(preview.after.attendanceData?.[0].clockOut).toBe('17:00');
    expect(original).toEqual(before);
  });

  it('does not reject an unrelated correction when existing worked attendance uses single-digit hours', () => {
    const preview = buildPayrollHolidayCorrection(salary([row('2026/09/25', 'worked', '8:00', '17:00')]), request({ holidays: [
      { date: '2026-09-28', holidayType: 'national_holiday', name: 'Synthetic holiday', mode: 'add' },
    ] }));
    expect(preview.delta.netSalary).toBe(0);
    expect(preview.after.attendanceData?.[0].clockIn).toBe('8:00');
  });

  it.each(['24:00', '8:60', '--:--', '', '8:0', ' 8:00', '8:00 '])('still rejects unavailable or invalid actual work time %j', (clockIn) => {
    expectError(() => buildPayrollHolidayCorrection(salary([row('2026/09/25', null, clockIn)]), request({ holidays: [
      { date: '2026-09-25', holidayType: 'worked', name: 'Synthetic worked holiday', mode: 'replace' },
    ] })), 'ACTUAL_WORK_TIMES_REQUIRED');
  });

  it('adds September 25 and 28 without paying national holidays twice or changing the original snapshot', () => {
    const original = salary([row('2026/09/24')]);
    const frozenCopy = structuredClone(original);
    const preview = buildPayrollHolidayCorrection(original, request());
    expect(preview.delta).toEqual({ grossSalary: 0, totalDeductions: 0, netSalary: 0, totalHolidayPay: 0, holidayDays: 0 });
    expect(preview.after.attendanceData?.map((entry) => entry.date)).toEqual(['2026/09/24', '2026-09-25', '2026-09-28']);
    expect(preview.after.attendanceData?.slice(1).every((entry) => entry.clockIn === '--:--' && entry.clockOut === '--:--')).toBe(true);
    expect(preview.after.baseSalary).toBe(original.baseSalary);
    expect(preview.after.totalOvertimePay).toBe(original.totalOvertimePay);
    expect(preview.after.holidayDays).toBe(original.holidayDays);
    expect(preview.after.deductions).toEqual(original.deductions);
    expect(preview.before).toEqual(original);
    expect(preview.before).not.toBe(original);
    expect(original).toEqual(frozenCopy);
    expect(preview.calculationNote).toContain('國定假日已包含在月薪');
  });

  it('replaces an exactly matched sick leave deduction with a paid national holiday', () => {
    const original = salary([row('2026/09/25', 'sick_leave', '--:--', '--:--')]);
    const preview = buildPayrollHolidayCorrection(original, request({ holidays: [
      { date: '2026-09-25', holidayType: 'national_holiday', name: 'Synthetic holiday', mode: 'replace' },
    ], paymentHandling: 'paid_adjustment' }));
    expect(preview.delta.netSalary).toBe(500);
    expect(preview.delta.totalDeductions).toBe(-500);
    expect(preview.after.deductions).toEqual([{ name: 'Synthetic withholding', amount: 1000 }]);
    expect(preview.after.attendanceData?.[0].clockIn).toBe('--:--');
    expect(preview.after.totalOvertimePay).toBe(original.totalOvertimePay);
    expect(preview.paymentHandling).toBe('paid_adjustment');
  });

  it.each(['sick_leave', 'personal_leave', 'typhoon_leave'] as const)('uses existing %s rules for a newly added full-day leave', (holidayType) => {
    const preview = buildPayrollHolidayCorrection(salary(), request({ holidays: [
      { date: '2026-09-25', holidayType, name: 'Synthetic leave', mode: 'add' },
    ] }));
    expect(preview.delta.totalDeductions).toBe(holidayType === 'sick_leave' ? 500 : 1000);
    expect(preview.delta.netSalary).toBe(-preview.delta.totalDeductions);
    expect(preview.after.deductions?.reduce((sum, item) => sum + item.amount, 0)).toBe(preview.after.totalDeductions);
  });

  it('supports worked holidays only from actual original clock times and preserves overtime and allowances', () => {
    const original = salary([row('2026-09-25')]);
    original.attendanceData![0].overtimeHours = { ot1: 1, ot2: 0 };
    const preview = buildPayrollHolidayCorrection(original, request({ holidays: [
      { date: '2026-09-25', holidayType: 'worked', name: 'Synthetic worked holiday', mode: 'replace' },
    ], paymentHandling: 'unpaid' }));
    expect(preview.delta.totalHolidayPay).toBe(1000);
    expect(preview.delta.netSalary).toBe(1000);
    expect(preview.delta.holidayDays).toBe(1);
    expect(preview.after.attendanceData?.[0].clockIn).toBe('08:00');
    expect(preview.after.attendanceData?.[0].clockOut).toBe('17:00');
    expect(preview.after.attendanceData?.[0].overtimeHours).toEqual({ ot1: 1, ot2: 0 });
    expect(preview.after.totalOT1Hours).toBe(original.totalOT1Hours);
    expect(preview.after.totalOT2Hours).toBe(original.totalOT2Hours);
    expect(preview.after.totalOvertimePay).toBe(original.totalOvertimePay);
    expect(preview.after.allowances).toEqual(original.allowances);
    expect(preview.after.baseSalary).toBe(original.baseSalary);
  });

  it('removes the original worked-holiday increment without overwriting manual holiday pay', () => {
    const original = salary([row('2026-09-25', 'worked')]);
    original.totalHolidayPay! += 250;
    original.grossSalary += 250;
    original.netSalary += 250;
    const preview = buildPayrollHolidayCorrection(original, request({ holidays: [
      { date: '2026-09-25', holidayType: 'national_holiday', name: 'Synthetic national holiday', mode: 'replace' },
    ] }));
    expect(preview.delta).toEqual({ grossSalary: -1000, totalDeductions: 0, netSalary: -1000, totalHolidayPay: -1000, holidayDays: -1 });
    expect(preview.after.totalHolidayPay).toBe(250);
    expect(preview.after.attendanceData?.[0].clockOut).toBe('17:00');
  });

  it.each([24000, 36000])('uses the original worked-holiday basis after a manual base salary edit to %s', (baseSalary) => {
    const original = salary([row('2026-09-25', 'worked')]);
    const manual = buildHistorySalaryEdit(original, { baseSalary }, 'Correct synthetic monthly base', 'unpaid');
    expect(manual.after.baseSalary).toBe(baseSalary);
    expect(manual.after.holidayCalculationBaseSalary).toBe(30000);
    expect(manual.after.totalHolidayPay).toBe(1000);
    const preview = buildPayrollHolidayCorrection(manual.after, request({ holidays: [
      { date: '2026-09-25', holidayType: 'national_holiday', name: 'Synthetic national holiday', mode: 'replace' },
    ] }));
    expect(preview.delta).toEqual({ grossSalary: -1000, totalDeductions: 0, netSalary: -1000, totalHolidayPay: -1000, holidayDays: -1 });
    expect(preview.after.totalHolidayPay).toBe(0);
    expect(preview.after.baseSalary).toBe(baseSalary);
    expect(preview.after.holidayCalculationBaseSalary).toBe(30000);
    expect(preview.after.totalOvertimePay).toBe(original.totalOvertimePay);
    expect(preview.after.grossSalary).toBe(manual.after.grossSalary - 1000);
    expect(preview.after.netSalary).toBe(manual.after.netSalary - 1000);
  });

  it.each([24000, 36000])('matches original leave deductions after a manual base salary edit to %s', (baseSalary) => {
    const original = salary([row('2026-09-25', 'sick_leave', '--:--', '--:--')]);
    const manual = buildHistorySalaryEdit(original, { baseSalary }, 'Correct synthetic monthly base', 'unpaid');
    const preview = buildPayrollHolidayCorrection(manual.after, request({ holidays: [
      { date: '2026-09-25', holidayType: 'national_holiday', name: 'Synthetic national holiday', mode: 'replace' },
    ] }));
    expect(preview.delta.totalDeductions).toBe(-500);
    expect(preview.delta.netSalary).toBe(500);
    expect(preview.after.deductions).toEqual([{ name: 'Synthetic withholding', amount: 1000 }]);
    expect(preview.after.holidayCalculationBaseSalary).toBe(30000);
    expect(preview.after.baseSalary).toBe(baseSalary);
  });

  it('uses the original calculation basis for a new worked-holiday classification after a manual base edit', () => {
    const manual = buildHistorySalaryEdit(salary([row('2026-09-25')]), { baseSalary: 24000 }, 'Correct synthetic monthly base', 'unpaid');
    const preview = buildPayrollHolidayCorrection(manual.after, request({ holidays: [
      { date: '2026-09-25', holidayType: 'worked', name: 'Synthetic worked holiday', mode: 'replace' },
    ] }));
    expect(preview.delta.totalHolidayPay).toBe(1000);
    expect(preview.after.holidayCalculationBaseSalary).toBe(30000);
    expect(preview.after.baseSalary).toBe(24000);
  });

  it('captures the stored base on the first correction of a legacy record without a calculation basis', () => {
    const original = salary();
    delete (original as Partial<SalaryRecord>).holidayCalculationBaseSalary;
    const preview = buildPayrollHolidayCorrection(original, request());
    expect(preview.before.holidayCalculationBaseSalary).toBeUndefined();
    expect(preview.after.holidayCalculationBaseSalary).toBe(30000);
    expect(preview.delta.netSalary).toBe(0);
  });

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])('refuses invalid original holiday calculation basis %s', (basis) => {
    const original = salary();
    original.holidayCalculationBaseSalary = basis;
    expectError(() => buildPayrollHolidayCorrection(original, request()), 'INVALID_HOLIDAY_CALCULATION_BASIS');
  });

  it('reads the server revision and normalizes the audit reason', () => {
    const original = Object.assign(salary(), { revision: 4 });
    const preview = buildPayrollHolidayCorrection(original, request({ reason: '  Correct omissions  ' }));
    expect(preview.revision).toBe(4);
    expect(preview.reason).toBe('Correct omissions');
    expect(preview.before).toEqual(original);
  });

  it('rejects a second addition after reopening a corrected historical record', () => {
    const corrected = buildPayrollHolidayCorrection(salary(), request()).after;
    expectError(() => buildPayrollHolidayCorrection(corrected, request()), 'ATTENDANCE_DATE_ALREADY_EXISTS');
  });

  it.each([
    ['2026-09-31', 'INVALID_HOLIDAY_DATE'],
    ['2026-08-25', 'HOLIDAY_OUTSIDE_SALARY_MONTH'],
    ['2026-10-01', 'HOLIDAY_OUTSIDE_SALARY_MONTH'],
  ])('rejects invalid or cross-month date %s', (date, code) => {
    expectError(() => buildPayrollHolidayCorrection(salary(), request({ holidays: [
      { date, holidayType: 'national_holiday', name: 'Synthetic holiday', mode: 'add' },
    ] })), code, 400);
  });

  it('rejects duplicate correction dates, including different categories', () => {
    const input = request();
    input.holidays[1] = { ...input.holidays[0], holidayType: 'personal_leave' };
    expectError(() => buildPayrollHolidayCorrection(salary(), input), 'DUPLICATE_HOLIDAY_DATE', 400);
  });

  it('rejects adding over existing attendance in either date format', () => {
    expectError(() => buildPayrollHolidayCorrection(salary([row('2026/09/25')]), request()), 'ATTENDANCE_DATE_ALREADY_EXISTS');
  });

  it('rejects replacing an absent date', () => {
    expectError(() => buildPayrollHolidayCorrection(salary(), request({ holidays: [
      { date: '2026-09-25', holidayType: 'national_holiday', name: 'Synthetic holiday', mode: 'replace' },
    ] })), 'ATTENDANCE_DATE_NOT_FOUND');
  });

  it.each(['--:--', '23:61', '', '08:00'])('rejects worked holiday replacement without real work ending at %s', (clockOut) => {
    expectError(() => buildPayrollHolidayCorrection(salary([row('2026-09-25', null, '08:00', clockOut)]), request({ holidays: [
      { date: '2026-09-25', holidayType: 'worked', name: 'Synthetic worked holiday', mode: 'replace' },
    ] })), 'ACTUAL_WORK_TIMES_REQUIRED');
  });

  it('rejects creating worked holidays without original attendance', () => {
    expectError(() => buildPayrollHolidayCorrection(salary(), request({ holidays: [
      { date: '2026-09-25', holidayType: 'worked', name: 'Synthetic worked holiday', mode: 'add' },
    ] })), 'ACTUAL_WORK_TIMES_REQUIRED');
  });

  it('rejects special leave without an original balance snapshot', () => {
    expectError(() => buildPayrollHolidayCorrection(salary(), request({ holidays: [
      { date: '2026-09-25', holidayType: 'special_leave', name: 'Synthetic special leave', mode: 'add' },
    ] })), 'SPECIAL_LEAVE_BALANCE_SNAPSHOT_REQUIRED');
    expectError(() => buildPayrollHolidayCorrection(salary([row('2026-09-25', 'special_leave', '--:--', '--:--')]), request({
      holidays: [{ date: '2026-09-25', holidayType: 'national_holiday', name: 'Synthetic holiday', mode: 'replace' }],
    })), 'SPECIAL_LEAVE_BALANCE_SNAPSHOT_REQUIRED');
  });

  it.each([null, 0])('rejects unidentified employee %s', (employeeId) => {
    const original = salary(); original.employeeId = employeeId;
    expectError(() => buildPayrollHolidayCorrection(original, request()), 'INAPPLICABLE_SALARY_RECORD');
  });

  it('rejects anonymized salaries and missing, mixed-employee, cross-month, or ambiguous snapshots', () => {
    const anonymized = salary(); anonymized.anonymizedAt = new Date();
    expectError(() => buildPayrollHolidayCorrection(anonymized, request()), 'INAPPLICABLE_SALARY_RECORD');
    const missing = salary(); missing.attendanceData = null;
    expectError(() => buildPayrollHolidayCorrection(missing, request()), 'INCOMPLETE_ATTENDANCE_SNAPSHOT');
    const mixed = salary([row('2026-09-24')]); mixed.attendanceData![0].employeeId = 43;
    expectError(() => buildPayrollHolidayCorrection(mixed, request()), 'INCONSISTENT_ATTENDANCE_SNAPSHOT');
    const crossMonth = salary([row('2026-08-24')]);
    expectError(() => buildPayrollHolidayCorrection(crossMonth, request()), 'INCONSISTENT_ATTENDANCE_SNAPSHOT');
    const ambiguous = salary([row('2026-09-24'), row('2026/09/24')]);
    expectError(() => buildPayrollHolidayCorrection(ambiguous, request()), 'AMBIGUOUS_ATTENDANCE_DATE');
  });

  it('refuses inconsistent totals or a leave deduction that does not match the original snapshot', () => {
    const invalidTotal = salary(); invalidTotal.netSalary -= 1;
    expectError(() => buildPayrollHolidayCorrection(invalidTotal, request()), 'INCONSISTENT_FINANCIAL_SNAPSHOT');
    const invalidLeave = salary([row('2026-09-25', 'sick_leave', '--:--', '--:--')]);
    invalidLeave.deductions![1].amount += 1;
    invalidLeave.totalDeductions! += 1;
    invalidLeave.netSalary -= 1;
    expectError(() => buildPayrollHolidayCorrection(invalidLeave, request({ holidays: [
      { date: '2026-09-25', holidayType: 'national_holiday', name: 'Synthetic holiday', mode: 'replace' },
    ] })), 'UNVERIFIABLE_LEAVE_DEDUCTIONS');
  });

  it('refuses stale automatic deduction entries and insufficient holiday pay in the snapshot', () => {
    const stale = salary();
    const autoItem = calculateHolidayPayAdjustments([{ date: '2026-09-24', holidayType: 'sick_leave', clockIn: '--:--', clockOut: '--:--' }], 30000).deductionItems[0];
    stale.deductions!.push(autoItem); stale.totalDeductions! += autoItem.amount; stale.netSalary -= autoItem.amount;
    expectError(() => buildPayrollHolidayCorrection(stale, request({ holidays: [
      { date: '2026-09-25', holidayType: 'sick_leave', name: 'Synthetic sick leave', mode: 'add' },
    ] })), 'UNVERIFIABLE_LEAVE_DEDUCTIONS');
    const insufficient = salary([row('2026-09-24', 'worked')]); insufficient.totalHolidayPay = 0;
    expectError(() => buildPayrollHolidayCorrection(insufficient, request()), 'INCONSISTENT_HOLIDAY_PAY_SNAPSHOT');
  });

  it.each(['', '  ', 'x'.repeat(1001)])('rejects empty or oversized reasons', (reason) => {
    expectError(() => buildPayrollHolidayCorrection(salary(), request({ reason })), 'INVALID_CORRECTION_REQUEST', 400);
  });

  it('rejects additional employee, amount, or clock fields from clients', () => {
    const input = request() as PayrollCorrectionRequest & { employeeId: number };
    input.employeeId = 43;
    expectError(() => buildPayrollHolidayCorrection(salary(), input), 'INVALID_CORRECTION_REQUEST', 400);
    const clockInput = request();
    Object.assign(clockInput.holidays[0], { clockIn: '08:00', clockOut: '17:00' });
    expectError(() => buildPayrollHolidayCorrection(salary(), clockInput), 'INVALID_CORRECTION_REQUEST', 400);
  });

  it('rejects malformed rows, unknown holiday categories, and ambiguous holiday flags', () => {
    const malformed = salary(); malformed.attendanceData = [null] as unknown as TemporaryAttendance[];
    expectError(() => buildPayrollHolidayCorrection(malformed, request()), 'INCONSISTENT_ATTENDANCE_SNAPSHOT');
    const unknown = salary([row('2026-09-24', 'unknown_category')]);
    expectError(() => buildPayrollHolidayCorrection(unknown, request()), 'INCONSISTENT_ATTENDANCE_SNAPSHOT');
    const ambiguous = salary([row('2026-09-24')]); ambiguous.attendanceData![0].isHoliday = true;
    expectError(() => buildPayrollHolidayCorrection(ambiguous, request()), 'AMBIGUOUS_HOLIDAY_CLASSIFICATION');
    const mismatched = salary([row('2026-09-24', 'national_holiday', '--:--', '--:--')]);
    mismatched.attendanceData![0].isHoliday = false;
    expectError(() => buildPayrollHolidayCorrection(mismatched, request()), 'AMBIGUOUS_HOLIDAY_CLASSIFICATION');
  });

  it('accepts a legacy ordinary attendance row without an optional holiday category', () => {
    const original = salary([row('2026-09-24')]);
    delete (original.attendanceData![0] as Partial<TemporaryAttendance>).holidayType;
    const preview = buildPayrollHolidayCorrection(original, request());
    expect(preview.delta.netSalary).toBe(0);
    expect(preview.after.attendanceData).toHaveLength(3);
  });
  it('preserves special leave cash and historical allowances while returning a complete revised snapshot', () => {
    const original = salary();
    original.specialLeaveInfo = { usedDays: 0, usedDates: [], cashDays: 2, cashAmount: 2000, cashMonth: '2026-09' };
    original.grossSalary += 2000; original.netSalary += 2000;
    const preview = buildPayrollHolidayCorrection(original, request());
    expect(preview.after.specialLeaveInfo).toEqual(original.specialLeaveInfo);
    expect(preview.after.allowances).toEqual(original.allowances);
    expect(preview.after.createdAt).toEqual(original.createdAt);
    expect(preview.after.grossSalary).toBe(original.grossSalary);
  });
});
