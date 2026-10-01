import type { InsertSalaryRecord, SalaryRecord } from '@shared/schema';
import type { PayrollCorrectionPreview, PayrollCorrectionRequest } from '@shared/payrollCorrection';
import { calculateGrossSalary, calculateNetSalary } from '@shared/utils/salaryMath';
import { PayrollCorrectionError } from './payrollCorrection';
import { payrollHash } from './payrollPreviewToken';

export function buildHistorySalaryEdit(record: SalaryRecord, input: Partial<InsertSalaryRecord>, reason: string, paymentHandling: PayrollCorrectionRequest['paymentHandling']): PayrollCorrectionPreview {
  if (!record.employeeId || record.anonymizedAt) throw new PayrollCorrectionError(409, 'INAPPLICABLE_SALARY_RECORD', 'An identified employee salary record is required for a correction.');
  for (const key of ['employeeId', 'employeeName', 'salaryYear', 'salaryMonth', 'attendanceData'] as const) {
    if (input[key] !== undefined && payrollHash(input[key]) !== payrollHash(record[key])) throw new PayrollCorrectionError(400, 'IMMUTABLE_SALARY_SCOPE', 'Employee, salary month and archived attendance must remain unchanged; use the holiday correction workflow.');
  }
  const after = { ...record, holidayCalculationBaseSalary: record.holidayCalculationBaseSalary ?? record.baseSalary };
  const hasValidItems = (entries: unknown): boolean => Array.isArray(entries) && entries.every((entry: unknown) => {
    if (!entry || typeof entry !== 'object') return false;
    const item = entry as Record<string, unknown>;
    return typeof item.name === 'string' && !!item.name.trim() && item.name.length <= 100 && typeof item.amount === 'number';
  });
  for (const entries of [input.allowances, input.deductions]) {
    if (entries !== undefined && entries !== null && !hasValidItems(entries)) {
      throw new PayrollCorrectionError(400, 'INVALID_SALARY_ITEM', 'Each salary item requires a text name and a numeric amount.');
    }
  }
  for (const key of ['baseSalary', 'housingAllowance', 'allowances', 'deductions', 'specialLeaveInfo'] as const) {
    if (input[key] !== undefined) Object.assign(after, { [key]: structuredClone(input[key]) });
  }
  const amounts = [after.baseSalary, after.housingAllowance ?? 0, after.totalOvertimePay ?? 0, after.totalHolidayPay ?? 0, after.specialLeaveInfo?.cashAmount ?? 0, ...(after.allowances ?? []).map(x => x.amount), ...(after.deductions ?? []).map(x => x.amount)];
  if (amounts.some(amount => !Number.isFinite(amount) || amount < 0)) throw new PayrollCorrectionError(400, 'INVALID_SALARY_AMOUNT', 'Salary amounts must be finite nonnegative numbers.');
  // The existing history editor treats explicit allowance rows as welfare allowance.
  after.welfareAllowance = input.allowances === undefined ? record.welfareAllowance ?? 0 : (after.allowances ?? []).reduce((sum, row) => sum + row.amount, 0);
  after.totalDeductions = (after.deductions ?? []).reduce((sum, row) => sum + row.amount, 0);
  after.grossSalary = calculateGrossSalary(after.baseSalary, after.totalOvertimePay ?? 0, after.totalHolidayPay ?? 0, after.welfareAllowance, after.housingAllowance ?? 0) + (after.specialLeaveInfo?.cashAmount ?? 0);
  after.netSalary = calculateNetSalary(after.grossSalary, after.totalDeductions);
  if (![after.grossSalary, after.totalDeductions, after.netSalary].every(Number.isFinite)) throw new PayrollCorrectionError(400, 'INVALID_SALARY_AMOUNT', 'Salary totals exceed the supported numeric range.');
  return {
    recordId: record.id, revision: record.revision ?? 0, before: record, after,
    delta: { grossSalary: after.grossSalary - record.grossSalary, totalDeductions: after.totalDeductions - (record.totalDeductions ?? 0), netSalary: after.netSalary - record.netSalary, totalHolidayPay: 0, holidayDays: 0 },
    holidays: [], reason, paymentHandling,
    calculationNote: 'Manual salary inputs were recalculated on the server using the original overtime and holiday amounts. No payment or notification was issued.',
  };
}
