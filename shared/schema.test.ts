import { describe, expect, it } from 'vitest';

import { holidayTypeOptions, insertHolidaySchema } from './schema';

describe('holiday schema', () => {
  it('accepts temporary stop work and classes holidays', () => {
    expect(() =>
      insertHolidaySchema.parse({
        employeeId: 1,
        date: '2026/06/26',
        name: '豪雨停班停課',
        holidayType: 'temporary_stop_work_and_classes',
        description: '因劇烈天候臨時停止上班上課',
      })
    ).not.toThrow();
  });

  it('exposes the temporary stop work and classes option in the shared holiday list', () => {
    expect(holidayTypeOptions).toContainEqual(
      expect.objectContaining({
        value: 'temporary_stop_work_and_classes',
        label: '臨時停止上班上課',
        paid: false,
        deductPay: true,
        description: '依公司規定處理',
      })
    );
  });
});
