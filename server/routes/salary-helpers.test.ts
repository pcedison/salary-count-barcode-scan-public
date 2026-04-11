import { describe, expect, it } from 'vitest';

import {
  deriveHolidayPayBase,
  filterAttendanceForSalaryMonth,
  mergeSalaryDeductions,
  normalizeSalaryDeductions,
  shouldRecalculateSalary
} from './salary-helpers';

describe('salary route helpers', () => {
  it('filters attendance by employee and mixed date formats', () => {
    const records = [
      { employeeId: 5, date: '2026/03/01', holidayType: 'worked' },
      { employeeId: 5, date: '2026-03-15', holidayType: 'sick_leave' },
      { employeeId: 5, date: '2026/04/01', holidayType: 'worked' },
      { employeeId: 6, date: '2026/03/20', holidayType: 'worked' }
    ];

    expect(filterAttendanceForSalaryMonth(records, 5, 2026, 3)).toEqual([
      { employeeId: 5, date: '2026/03/01', holidayType: 'worked' },
      { employeeId: 5, date: '2026-03-15', holidayType: 'sick_leave' }
    ]);
  });

  it('removes auto-generated leave deductions before appending recalculated ones', () => {
    expect(
      mergeSalaryDeductions(
        [
          { name: '勞保費', amount: 100 },
          { name: '病假扣款 (2026/03/01)', amount: 50 },
          { name: '颱風假扣款 (2026/03/02)', amount: 80 }
        ],
        [{ name: '病假扣款 (2026/03/03)', amount: 60 }]
      )
    ).toEqual([
      { name: '勞保費', amount: 100 },
      { name: '病假扣款 (2026/03/03)', amount: 60 }
    ]);
  });

  it('derives manual holiday pay without double-counting previous worked-holiday pay', () => {
    expect(
      deriveHolidayPayBase({
        storedTotalHolidayPay: 1800,
        previousWorkedHolidayPay: 1200
      })
    ).toBe(600);

    expect(
      deriveHolidayPayBase({
        explicitHolidayPay: 900,
        storedTotalHolidayPay: 1800,
        previousWorkedHolidayPay: 1200
      })
    ).toBe(900);
  });

  it('detects when a salary patch should trigger recalculation', () => {
    expect(shouldRecalculateSalary({ baseSalary: 32000 }, false)).toBe(true);
    expect(shouldRecalculateSalary({ employeeName: 'Test' }, false)).toBe(false);
    expect(shouldRecalculateSalary({ totalOT1Hours: 12 }, true)).toBe(false);
  });

  it('normalizes deduction payloads from loose JSON arrays', () => {
    expect(
      normalizeSalaryDeductions([
        { name: '勞保費', amount: 100 },
        { name: 'invalid' },
        'bad item'
      ])
    ).toEqual([{ name: '勞保費', amount: 100, description: undefined }]);
  });
});
