import { describe, expect, it } from 'vitest';

import { constants } from '../constants';
import {
  calculateDailyOvertimePay,
  calculateDailyOvertimeSummary,
  calculateGrossSalary,
  calculateNetSalary,
  calculateOvertime,
  calculateOvertimePay,
  normalizeSalarySettings
} from './salaryMath';

describe('salaryMath', () => {
  it('fills salary defaults from shared constants', () => {
    expect(normalizeSalarySettings()).toMatchObject({
      baseHourlyRate: constants.BASE_HOURLY_RATE,
      ot1Multiplier: constants.OT1_MULTIPLIER,
      ot2Multiplier: constants.OT2_MULTIPLIER,
      baseMonthSalary: constants.BASE_HOURLY_RATE * constants.STANDARD_WORK_DAYS * constants.STANDARD_WORK_HOURS,
      welfareAllowance: constants.DEFAULT_WELFARE_ALLOWANCE
    });
  });

  it('keeps overtime thresholds and pay consistent across helpers', () => {
    expect(calculateOvertime('08:00', '18:40')).toEqual({
      ot1: 2,
      ot2: 0.5,
      total: 10.7
    });

    const settings = {
      baseHourlyRate: 100,
      ot1Multiplier: 1.5,
      ot2Multiplier: 2
    };

    expect(calculateDailyOvertimeSummary('08:00', '18:40', settings)).toMatchObject({
      ot1: 2,
      ot2: 0.5,
      pay: 400
    });
    expect(calculateDailyOvertimePay('08:00', '18:40', settings)).toBe(400);
    expect(calculateOvertimePay({ totalOT1Hours: 2, totalOT2Hours: 0.5 }, settings)).toBe(400);
  });

  it('builds gross and net salary from the shared math helpers', () => {
    const grossSalary = calculateGrossSalary(30000, 1200, 300, 500, 200);
    expect(grossSalary).toBe(32200);
    expect(calculateNetSalary(grossSalary, 700)).toBe(31500);
  });
});
