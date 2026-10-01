export interface HistoryAllowanceItem {
  name: string;
  amount: number;
  description?: string;
}

export interface HistoryDeductionItem {
  name: string;
  amount: number;
}

export function initialHistoryAllowances(input: { allowances?: ReadonlyArray<HistoryAllowanceItem> | null; welfareAllowance?: number | null }): HistoryAllowanceItem[] {
  const rows = structuredClone([...(input.allowances ?? [])]);
  const difference = (input.welfareAllowance ?? 0) - rows.reduce((sum, row) => sum + row.amount, 0);
  // Keep a missing positive legacy balance visible; negative differences require explicit editing.
  if (difference > 0) rows.push({ name: '原結算津貼差額', amount: difference });
  return rows;
}

export interface HistorySpecialLeaveInfo {
  usedDays: number;
  usedDates: string[];
  cashDays: number;
  cashAmount: number;
  notes?: string;
}

export interface HistoryRecordTotalsInput {
  allowances?: HistoryAllowanceItem[];
  deductions?: HistoryDeductionItem[];
  baseSalary: number;
  housingAllowance?: number;
  totalOvertimePay?: number;
  totalHolidayPay?: number;
  specialLeaveInfo?: HistorySpecialLeaveInfo | null;
}

import {
  calculateGrossSalary as sharedCalculateGrossSalary,
  calculateNetSalary as sharedCalculateNetSalary
} from '@shared/utils/salaryMath';

export interface HistoryRecordTotals {
  totalAllowances: number;
  totalDeductions: number;
  welfareAllowance: number;
  grossSalary: number;
  netSalary: number;
}

export function calculateHistoryRecordTotals(
  input: HistoryRecordTotalsInput
): HistoryRecordTotals {
  const allowances = input.allowances || [];
  const deductions = input.deductions || [];
  const housingAllowance = input.housingAllowance || 0;
  const overtimePay = input.totalOvertimePay || 0;
  const holidayPay = input.totalHolidayPay || 0;
  const specialLeaveCash = input.specialLeaveInfo?.cashAmount || 0;

  const totalAllowances = allowances.reduce((sum, allowance) => sum + (allowance.amount || 0), 0);
  const totalDeductions = deductions.reduce((sum, deduction) => sum + (deduction.amount || 0), 0);
  const welfareAllowance = totalAllowances;
  const grossSalary = sharedCalculateGrossSalary(
    input.baseSalary,
    overtimePay,
    holidayPay,
    welfareAllowance,
    housingAllowance
  ) + specialLeaveCash;
  const netSalary = sharedCalculateNetSalary(grossSalary, totalDeductions);

  return {
    totalAllowances,
    totalDeductions,
    welfareAllowance,
    grossSalary,
    netSalary
  };
}
