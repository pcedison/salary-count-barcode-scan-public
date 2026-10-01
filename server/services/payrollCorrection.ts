import type { SalaryRecord, TemporaryAttendance } from '@shared/schema';
import {
  payrollCorrectionRequestSchema,
  payrollHolidayTypes,
  type PayrollCorrectionPreview,
  type PayrollCorrectionRequest,
} from '@shared/payrollCorrection';
import { calculateHolidayPayAdjustments } from '../utils/salaryCalculator';
import { parseClockTimeMinutes } from '@shared/utils/salaryMath';

export class PayrollCorrectionError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'PayrollCorrectionError';
  }
}

function conflict(code: string, message: string): never {
  throw new PayrollCorrectionError(409, code, message);
}

function normalizeSnapshotDate(value: unknown): string | null {
  const match = typeof value === 'string' ? value.match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/) : null;
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (year < 1000 || date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return null;
  }
  return `${match[1]}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function hasRealWorkTimes(record: TemporaryAttendance): boolean {
  const clockIn = parseClockTimeMinutes(record.clockIn);
  const clockOut = parseClockTimeMinutes(record.clockOut);
  if (clockIn === null || clockOut === null) return false;
  // The existing holiday calculator counts work after 08:00, within the same day.
  return clockOut > Math.max(8 * 60, clockIn);
}

function sameAmount(left: number, right: number): boolean {
  return Math.abs(left - right) <= 0.000001;
}

function assertFinancialSnapshot(record: SalaryRecord): void {
  const nonnegativeFields = [
    'baseSalary', 'housingAllowance', 'welfareAllowance', 'totalOT1Hours', 'totalOT2Hours',
    'totalOvertimePay', 'totalHolidayPay', 'totalDeductions', 'holidayDailySalary', 'holidayDays',
  ] as const;
  for (const field of nonnegativeFields) {
    const value = record[field];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      conflict('INCOMPLETE_FINANCIAL_SNAPSHOT', 'The stored payroll calculation is incomplete or invalid; review its original inputs first.');
    }
  }
  if (!Number.isInteger(record.holidayDays)) {
    conflict('INCONSISTENT_FINANCIAL_SNAPSHOT', 'The stored worked-holiday day count is invalid.');
  }
  if (!Number.isFinite(record.grossSalary) || !Number.isFinite(record.netSalary) || !Array.isArray(record.deductions)) {
    conflict('INCOMPLETE_FINANCIAL_SNAPSHOT', 'The stored salary totals or deduction details are missing.');
  }
  for (const item of record.deductions) {
    if (!item || typeof item.name !== 'string' || typeof item.amount !== 'number' || !Number.isFinite(item.amount) || item.amount < 0) {
      conflict('INCONSISTENT_FINANCIAL_SNAPSHOT', 'The stored deduction details are invalid.');
    }
  }
  const deductionSum = record.deductions.reduce((sum, item) => sum + item.amount, 0);
  if (!sameAmount(deductionSum, record.totalDeductions!) ||
      !sameAmount(record.grossSalary - record.netSalary, record.totalDeductions!)) {
    conflict('INCONSISTENT_FINANCIAL_SNAPSHOT', 'The stored salary and deduction totals disagree; reconcile them before applying a correction.');
  }
}

type HolidayAdjustments = ReturnType<typeof calculateHolidayPayAdjustments>;

function calculateSnapshotAdjustments(attendance: TemporaryAttendance[], baseSalary: number): HolidayAdjustments {
  return calculateHolidayPayAdjustments(attendance.map((row) => ({
    ...row,
    employeeId: row.employeeId ?? undefined,
    clockOut: row.clockOut ?? undefined,
  })), baseSalary);
}

function reconcileAutoDeductions(record: SalaryRecord, before: HolidayAdjustments, after: HolidayAdjustments) {
  const remaining = structuredClone(record.deductions!);
  for (const item of before.deductionItems) {
    const matches = remaining.map((stored, index) => ({ stored, index }))
      .filter(({ stored }) => stored.name === item.name);
    if (matches.length !== 1 || !sameAmount(matches[0].stored.amount, item.amount)) {
      conflict('UNVERIFIABLE_LEAVE_DEDUCTIONS', 'The original leave deduction cannot be matched exactly to the stored attendance snapshot.');
    }
    remaining.splice(matches[0].index, 1);
  }
  const canonicalPrefixes = calculateHolidayPayAdjustments(
    ['sick_leave', 'personal_leave', 'typhoon_leave', 'temporary_stop_work_and_classes'].map((holidayType) => ({
      date: '2000-01-01', holidayType, clockIn: '--:--', clockOut: '--:--',
    })), 30000,
  ).deductionItems.map((item) => item.name.split(' (')[0]);
  const autoPrefixes = ['sick_leave', 'personal_leave', 'typhoon_leave', 'temporary_stop_work_and_classes', ...canonicalPrefixes];
  const generatedPrefixes = [...before.deductionItems, ...after.deductionItems]
    .map((item) => item.name.split(' (')[0]);
  if (remaining.some((item) => [...autoPrefixes, ...generatedPrefixes]
    .some((prefix) => item.name.startsWith(`${prefix} (`)))) {
    conflict('UNVERIFIABLE_LEAVE_DEDUCTIONS', 'Unmatched leave deduction details require manual reconciliation.');
  }
  return [...remaining, ...after.deductionItems.map(({ name, amount }) => ({ name, amount }))];
}

/**
 * Builds a correction from finalized snapshots only. No database, current settings,
 * payment, email, or notification operations take place here.
 */
export function buildPayrollHolidayCorrection(
  record: SalaryRecord,
  request: PayrollCorrectionRequest,
): PayrollCorrectionPreview {
  const parsed = payrollCorrectionRequestSchema.safeParse(request);
  if (!parsed.success) {
    throw new PayrollCorrectionError(400, 'INVALID_CORRECTION_REQUEST', 'Provide valid holiday dates, types, a reason, and payment handling.');
  }
  const input = parsed.data;
  if (!Number.isInteger(record.id) || record.id <= 0 || !Number.isInteger(record.employeeId) ||
      !record.employeeId || record.employeeId < 0 || record.anonymizedAt) {
    conflict('INAPPLICABLE_SALARY_RECORD', 'Corrections require an identified, non-anonymized employee salary record.');
  }
  if (!Number.isInteger(record.salaryYear) || !Number.isInteger(record.salaryMonth) ||
      record.salaryMonth < 1 || record.salaryMonth > 12 || !Array.isArray(record.attendanceData)) {
    conflict('INCOMPLETE_ATTENDANCE_SNAPSHOT', 'The original salary period or attendance snapshot is missing.');
  }
  assertFinancialSnapshot(record);
  // Newly finalized records preserve this rate separately from later manual base edits.
  // Legacy records without a basis use their original stored base salary on first correction.
  const holidayCalculationBaseSalary = record.holidayCalculationBaseSalary ?? record.baseSalary;
  if (typeof holidayCalculationBaseSalary !== 'number' || !Number.isFinite(holidayCalculationBaseSalary) ||
      holidayCalculationBaseSalary < 0) {
    conflict('INVALID_HOLIDAY_CALCULATION_BASIS', 'The original holiday calculation base is invalid; reconcile its stored inputs first.');
  }
  const monthPrefix = `${record.salaryYear}-${String(record.salaryMonth).padStart(2, '0')}-`;
  const existingDates = new Map<string, number>();
  const attendance = structuredClone(record.attendanceData);
  for (let index = 0; index < attendance.length; index++) {
    const row = attendance[index];
    if (!row || typeof row !== 'object' || typeof row.clockIn !== 'string' ||
        (row.clockOut !== null && typeof row.clockOut !== 'string')) {
      conflict('INCONSISTENT_ATTENDANCE_SNAPSHOT', 'The original attendance row is missing valid clock fields.');
    }
    const knownHolidayType = typeof row.holidayType === 'string' &&
      (payrollHolidayTypes as readonly string[]).includes(row.holidayType);
    const normalType = row.holidayType == null || row.holidayType === '' ||
      row.holidayType === 'none' || row.holidayType === 'normal';
    if (!knownHolidayType && !normalType) {
      conflict('INCONSISTENT_ATTENDANCE_SNAPSHOT', 'The original attendance contains an unknown holiday classification.');
    }
    if ((knownHolidayType && row.isHoliday !== true) || (normalType && row.isHoliday === true)) {
      conflict('AMBIGUOUS_HOLIDAY_CLASSIFICATION', 'The original holiday flag and category disagree; reconcile the classification first.');
    }
    const date = normalizeSnapshotDate(row.date);
    if (!date || !date.startsWith(monthPrefix) || row.employeeId !== record.employeeId) {
      conflict('INCONSISTENT_ATTENDANCE_SNAPSHOT', 'The original attendance contains invalid dates, another month, or another employee.');
    }
    if (existingDates.has(date)) {
      conflict('AMBIGUOUS_ATTENDANCE_DATE', 'The original attendance contains multiple rows on one date; reconcile them first.');
    }
    if (row.holidayType === 'worked' && !hasRealWorkTimes(row)) {
      conflict('INVALID_WORKED_HOLIDAY', 'Worked holidays require valid, actual clock times in the original snapshot.');
    }
    existingDates.set(date, index);
  }
  const seenDates = new Set<string>();
  let nextSyntheticId = Math.min(0, ...attendance.map((row) => Number.isInteger(row.id) ? row.id : 0)) - 1;
  for (const holiday of input.holidays) {
    const date = normalizeSnapshotDate(holiday.date);
    if (!date) throw new PayrollCorrectionError(400, 'INVALID_HOLIDAY_DATE', 'The holiday date is not a valid calendar date.');
    if (!date.startsWith(monthPrefix)) {
      throw new PayrollCorrectionError(400, 'HOLIDAY_OUTSIDE_SALARY_MONTH', 'Each holiday must belong to this employee salary month.');
    }
    if (seenDates.has(date)) {
      throw new PayrollCorrectionError(400, 'DUPLICATE_HOLIDAY_DATE', 'Each correction date may appear only once.');
    }
    seenDates.add(date);
    if (holiday.holidayType === 'special_leave') {
      conflict('SPECIAL_LEAVE_BALANCE_SNAPSHOT_REQUIRED', 'Special leave corrections require an original leave balance snapshot, which this salary record does not contain.');
    }
    const existingIndex = existingDates.get(date);
    if (holiday.mode === 'add') {
      if (existingIndex !== undefined) {
        conflict('ATTENDANCE_DATE_ALREADY_EXISTS', 'Attendance or leave already exists on this date; review an explicit replacement instead.');
      }
      if (holiday.holidayType === 'worked') {
        conflict('ACTUAL_WORK_TIMES_REQUIRED', 'A worked holiday must replace an existing row with valid, actual clock times.');
      }
      attendance.push({
        id: nextSyntheticId--,
        employeeId: record.employeeId,
        date,
        clockIn: '--:--',
        clockOut: '--:--',
        isHoliday: true,
        isBarcodeScanned: false,
        holidayId: null,
        holidayType: holiday.holidayType,
        createdAt: null,
      });
    } else {
      if (existingIndex === undefined) {
        conflict('ATTENDANCE_DATE_NOT_FOUND', 'A replacement requires exactly one original attendance row on this date.');
      }
      const originalRow = attendance[existingIndex];
      if (originalRow.holidayType === 'special_leave') {
        conflict('SPECIAL_LEAVE_BALANCE_SNAPSHOT_REQUIRED', 'Replacing special leave requires the original leave balance snapshot.');
      }
      if (holiday.holidayType === 'worked' && !hasRealWorkTimes(originalRow)) {
        conflict('ACTUAL_WORK_TIMES_REQUIRED', 'Worked holidays require valid, actual clock times in the original snapshot.');
      }
      attendance[existingIndex] = { ...originalRow, isHoliday: true, holidayType: holiday.holidayType, holidayId: null };
    }
  }
  const previousAdjustments = calculateSnapshotAdjustments(record.attendanceData, holidayCalculationBaseSalary);
  const nextAdjustments = calculateSnapshotAdjustments(attendance, holidayCalculationBaseSalary);
  if (record.totalHolidayPay! + 0.000001 < previousAdjustments.workedHolidayPay ||
      record.holidayDays! < previousAdjustments.workedHolidayDays) {
    conflict('INCONSISTENT_HOLIDAY_PAY_SNAPSHOT', 'The stored holiday pay is less than the amount represented by its attendance snapshot.');
  }
  const totalHolidayPayDelta = nextAdjustments.workedHolidayPay - previousAdjustments.workedHolidayPay;
  const previousLeaveDeduction = previousAdjustments.deductionItems.reduce((sum, item) => sum + item.amount, 0);
  const nextLeaveDeduction = nextAdjustments.deductionItems.reduce((sum, item) => sum + item.amount, 0);
  const totalDeductionsDelta = nextLeaveDeduction - previousLeaveDeduction;
  const holidayDaysDelta = nextAdjustments.workedHolidayDays - previousAdjustments.workedHolidayDays;
  const deductionDetailsChanged = JSON.stringify(previousAdjustments.deductionItems) !== JSON.stringify(nextAdjustments.deductionItems);
  const financialChange = totalHolidayPayDelta !== 0 || totalDeductionsDelta !== 0;
  const deductions = deductionDetailsChanged || financialChange
    ? reconcileAutoDeductions(record, previousAdjustments, nextAdjustments)
    : structuredClone(record.deductions!);
  const grossSalaryDelta = totalHolidayPayDelta;
  const netSalaryDelta = grossSalaryDelta - totalDeductionsDelta;
  const before = structuredClone(record);
  const after: SalaryRecord = {
    ...structuredClone(record),
    holidayCalculationBaseSalary,
    attendanceData: attendance.sort((left, right) => normalizeSnapshotDate(left.date)!.localeCompare(normalizeSnapshotDate(right.date)!)),
    deductions,
    holidayDays: record.holidayDays! + holidayDaysDelta,
    totalHolidayPay: record.totalHolidayPay! + totalHolidayPayDelta,
    totalDeductions: record.totalDeductions! + totalDeductionsDelta,
    grossSalary: record.grossSalary + grossSalaryDelta,
    netSalary: record.netSalary + netSalaryDelta,
  };
  assertFinancialSnapshot(after);
  const revision = 'revision' in record && typeof record.revision === 'number' ? record.revision : 0;
  return {
    recordId: record.id,
    revision,
    before,
    after,
    delta: {
      grossSalary: grossSalaryDelta,
      totalDeductions: totalDeductionsDelta,
      netSalary: netSalaryDelta,
      totalHolidayPay: totalHolidayPayDelta,
      holidayDays: holidayDaysDelta,
    },
    holidays: input.holidays,
    reason: input.reason,
    paymentHandling: input.paymentHandling,
    calculationNote: '國定假日已包含在月薪，未出勤的國定假日補登可能只有分類變更、金額差額為零。此預覽沿用原結算資料與計薪基準；已發薪或付款狀態待核對的差額，須由管理者另行處理。保存更正不會付款或通知員工。',
  };
}
