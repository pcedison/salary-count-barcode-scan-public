import { describe, expect, it } from 'vitest';

import { constants } from './constants';
import { calculateDailyOvertimePay, calculateOvertime } from './salaryCalculations';
import {
  calculateDailyOvertimePay as sharedCalculateDailyOvertimePay,
  calculateOvertime as sharedCalculateOvertime,
} from '@shared/utils/salaryMath';

describe('salaryCalculations', () => {
  it('calculateOvertime mirrors the shared breakdown without the total field', () => {
    const cases: Array<[string, string]> = [
      ['08:00', '16:00'],
      ['08:00', '16:10'],
      ['08:00', '17:10'],
      ['08:00', '18:10'],
      ['08:00', '19:45'],
    ];

    for (const [clockIn, clockOut] of cases) {
      const shared = sharedCalculateOvertime(clockIn, clockOut);
      expect(calculateOvertime(clockIn, clockOut), `${clockIn}-${clockOut}`).toEqual({
        ot1: shared.ot1,
        ot2: shared.ot2,
      });
    }
  });

  it('calculateDailyOvertimePay derives the hourly rate from the monthly base salary', () => {
    const baseSalary = 30000;
    const hourlyRate =
      baseSalary / constants.STANDARD_WORK_DAYS / constants.STANDARD_WORK_HOURS;

    const expected = sharedCalculateDailyOvertimePay('08:00', '19:45', {
      baseHourlyRate: hourlyRate,
      ot1Multiplier: constants.OT1_MULTIPLIER,
      ot2Multiplier: constants.OT2_MULTIPLIER,
    });

    expect(calculateDailyOvertimePay('08:00', '19:45', baseSalary)).toBe(expected);
  });

  it('returns zero pay for a day with no overtime', () => {
    expect(calculateDailyOvertimePay('08:00', '16:00', 30000)).toBe(0);
  });
});
