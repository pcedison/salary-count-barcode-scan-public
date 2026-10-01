import { describe, expect, it } from 'vitest';
import { calculateHistoryRecordTotals, initialHistoryAllowances } from './historyRecordMath';
describe('legacy historical allowance display', () => {
  it('materializes an existing allowance balance when old rows are absent', () => expect(initialHistoryAllowances({ allowances: [], welfareAllowance: 1200 })).toEqual([{ name: '原結算津貼差額', amount: 1200 }]));
  it('preserves positive differences in the historical welfare total', () => {
    const input = { allowances: [{ name: 'Synthetic Allowance', amount: 700 }], welfareAllowance: 1200 };
    const rows = initialHistoryAllowances(input);
    expect(rows.reduce((sum, row) => sum + row.amount, 0)).toBe(1200);
    expect(input.allowances).toHaveLength(1);
  });
  it('never creates a negative allowance to reconcile an ambiguous legacy balance', () => expect(initialHistoryAllowances({ allowances: [{ name: 'Synthetic Allowance', amount: 1700 }], welfareAllowance: 1200 })).toEqual([{ name: 'Synthetic Allowance', amount: 1700 }]));
  it('leaves stored welfare in the unchanged preview and shows a delta only after explicit editing', () => {
    const common = { baseSalary: 30000, housingAllowance: 0, totalOvertimePay: 0, totalHolidayPay: 0, deductions: [] };
    const unchanged = calculateHistoryRecordTotals({ ...common, allowances: [{ name: 'Stored welfare', amount: 1200 }] });
    const edited = calculateHistoryRecordTotals({ ...common, allowances: [{ name: 'Edited detail', amount: 1700 }] });
    expect(unchanged.netSalary).toBe(31200);
    expect(edited.netSalary - unchanged.netSalary).toBe(500);
  });
});
