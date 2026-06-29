import { describe, expect, it } from 'vitest';

import { calculateHolidayPayAdjustments } from './salaryCalculator';

describe('calculateHolidayPayAdjustments', () => {
  it('deducts a full day for temporary stop work and classes leave', () => {
    const result = calculateHolidayPayAdjustments(
      [
        {
          date: '2026/06/26',
          holidayType: 'temporary_stop_work_and_classes',
          clockIn: '--:--',
          clockOut: '--:--',
        },
      ],
      30000
    );

    expect(result.deductionItems).toContainEqual({
      name: '臨時停止上班上課扣款 (2026/06/26)',
      amount: 1000,
      description: '臨時停止上班上課未出勤，扣除日薪100%',
    });
  });
});
