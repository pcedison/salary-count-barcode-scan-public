import { describe, expect, it } from 'vitest';

import { calculateHistoryRecordTotals } from './historyRecordMath';

describe('calculateHistoryRecordTotals', () => {
  it('calculates totals for allowances and deductions used by history editing', () => {
    expect(
      calculateHistoryRecordTotals({
        allowances: [
          { name: '福利金', amount: 1000 },
          { name: '交通津貼', amount: 500 }
        ],
        deductions: [
          { name: '勞保', amount: 300 },
          { name: '健保', amount: 200 }
        ],
        baseSalary: 30000,
        housingAllowance: 2500,
        totalOvertimePay: 1800,
        totalHolidayPay: 1200,
        specialLeaveInfo: {
          usedDays: 1,
          usedDates: ['2025-03-10'],
          cashDays: 1,
          cashAmount: 1000
        }
      })
    ).toEqual({
      totalAllowances: 1500,
      totalDeductions: 500,
      welfareAllowance: 1500,
      grossSalary: 38000,
      netSalary: 37500
    });
  });

  it('handles empty allowances and deductions without NaN', () => {
    expect(
      calculateHistoryRecordTotals({
        baseSalary: 28590
      })
    ).toEqual({
      totalAllowances: 0,
      totalDeductions: 0,
      welfareAllowance: 0,
      grossSalary: 28590,
      netSalary: 28590
    });
  });
});
