import type { InsertSalaryRecord, TemporaryAttendance } from '@shared/schema';

import type { CalculationSettings } from '../utils/salaryCalculator';

export interface SalaryDeductionItem {
  name: string;
  amount: number;
  description?: string;
}

const AUTO_LEAVE_DEDUCTION_KEYWORDS = ['病假扣款', '事假扣款', '颱風假扣款'];

export function matchesSalaryYearMonth(
  date: string | null | undefined,
  year: number,
  month: number
): boolean {
  if (!date) {
    return false;
  }

  const dateParts = date.split(/[/-]/);
  if (dateParts.length !== 3) {
    return false;
  }

  const parsedYear = Number.parseInt(dateParts[0], 10);
  const parsedMonth = Number.parseInt(dateParts[1], 10);

  return parsedYear === year && parsedMonth === month;
}

export function filterAttendanceForSalaryMonth(
  attendanceRecords: Array<
    Pick<TemporaryAttendance, 'date' | 'employeeId' | 'holidayType' | 'clockIn' | 'clockOut'>
  >,
  employeeId: number | null | undefined,
  year: number,
  month: number
) {
  if (!employeeId) {
    return [];
  }

  return attendanceRecords.filter(record => {
    if (record.employeeId !== employeeId) {
      return false;
    }

    return matchesSalaryYearMonth(record.date, year, month);
  });
}

export function stripAutoLeaveDeductions(
  deductions: SalaryDeductionItem[] = []
): SalaryDeductionItem[] {
  return deductions.filter(
    deduction =>
      typeof deduction.name === 'string' &&
      !AUTO_LEAVE_DEDUCTION_KEYWORDS.some(keyword => deduction.name.includes(keyword))
  );
}

export function mergeSalaryDeductions(
  deductions: SalaryDeductionItem[] = [],
  holidayDeductionItems: SalaryDeductionItem[] = []
): SalaryDeductionItem[] {
  return [...stripAutoLeaveDeductions(deductions), ...holidayDeductionItems];
}

export function normalizeSalaryDeductions(deductions: unknown): SalaryDeductionItem[] {
  if (!Array.isArray(deductions)) {
    return [];
  }

  return deductions
    .filter(
      (deduction): deduction is SalaryDeductionItem =>
        typeof deduction === 'object' &&
        deduction !== null &&
        typeof (deduction as SalaryDeductionItem).name === 'string' &&
        typeof (deduction as SalaryDeductionItem).amount === 'number'
    )
    .map(deduction => ({
      name: deduction.name,
      amount: deduction.amount,
      description: deduction.description
    }));
}

export function toCalculationSettings(settings: {
  baseHourlyRate: number;
  ot1Multiplier: number;
  ot2Multiplier: number;
  baseMonthSalary: number;
  welfareAllowance?: number | null;
}): CalculationSettings {
  return {
    baseHourlyRate: settings.baseHourlyRate,
    ot1Multiplier: settings.ot1Multiplier,
    ot2Multiplier: settings.ot2Multiplier,
    baseMonthSalary: settings.baseMonthSalary,
    welfareAllowance: settings.welfareAllowance || 0
  };
}

export function deriveHolidayPayBase(options: {
  explicitHolidayPay?: number | null;
  storedTotalHolidayPay?: number | null;
  previousWorkedHolidayPay?: number | null;
}): number {
  if (options.explicitHolidayPay !== undefined && options.explicitHolidayPay !== null) {
    return options.explicitHolidayPay;
  }

  const storedTotalHolidayPay = options.storedTotalHolidayPay || 0;
  const previousWorkedHolidayPay = options.previousWorkedHolidayPay || 0;
  return Math.max(0, storedTotalHolidayPay - previousWorkedHolidayPay);
}

/**
 * Determines whether the server should recalculate salary fields based on the
 * provided update data.
 *
 * @param updateData - The fields being patched on the salary record.
 * @param skipRecalculation - When `true` the caller is submitting pre-calculated
 *   values (e.g. a manual edit or a client-side correction) and the server must
 *   persist them as-is without re-running the salary formula.  When `false`
 *   (the default), any change to an input field triggers a full server-side
 *   recalculation so that derived totals stay consistent.
 *
 * NOTE: the name of the second parameter was previously `forceUpdate`, which
 * was misleading (the parameter actually *skips* recalculation, not forces it).
 * It has been renamed for clarity.
 */
export function shouldRecalculateSalary(
  updateData: Partial<InsertSalaryRecord>,
  skipRecalculation: boolean
): boolean {
  if (skipRecalculation) {
    // Caller explicitly bypasses server-side recalculation — trust the submitted values.
    return false;
  }

  return (
    updateData.totalOT1Hours !== undefined ||
    updateData.totalOT2Hours !== undefined ||
    updateData.baseSalary !== undefined ||
    updateData.deductions !== undefined ||
    updateData.housingAllowance !== undefined ||
    updateData.welfareAllowance !== undefined ||
    updateData.totalHolidayPay !== undefined ||
    updateData.employeeId !== undefined ||
    updateData.salaryYear !== undefined ||
    updateData.salaryMonth !== undefined
  );
}
