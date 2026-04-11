import { describe, expect, it } from 'vitest';

import { constants } from './constants';
import {
  calculateDailyOvertimePay,
  calculateGrossSalary,
  calculateNetSalary,
  calculateOvertime,
  calculateOvertimePay,
  calculateSalary,
  validateSalaryRecord
} from './salaryCalculations';
import {
  calculateDailyOvertimePay as sharedCalculateDailyOvertimePay,
  calculateGrossSalary as sharedCalculateGrossSalary,
  calculateNetSalary as sharedCalculateNetSalary,
  calculateOvertime as sharedCalculateOvertime,
  calculateOvertimePay as sharedCalculateOvertimePay
} from '@shared/utils/salaryMath';

describe('salaryCalculations', () => {
  const settings = {
    baseHourlyRate: constants.BASE_HOURLY_RATE,
    ot1Multiplier: constants.OT1_MULTIPLIER,
    ot2Multiplier: constants.OT2_MULTIPLIER,
    baseMonthSalary: constants.BASE_HOURLY_RATE * constants.STANDARD_WORK_DAYS * constants.STANDARD_WORK_HOURS,
    welfareAllowance: constants.DEFAULT_WELFARE_ALLOWANCE
  };

  it('delegates overtime pay to the shared salary math', () => {
    expect(calculateOvertimePay({ totalOT1Hours: 1, totalOT2Hours: 0 }, settings)).toBe(159);
  });

  it('keeps the client overtime helpers aligned with the shared math', () => {
    expect(calculateOvertime('08:00', '18:40')).toMatchObject({
      ot1: sharedCalculateOvertime('08:00', '18:40').ot1,
      ot2: sharedCalculateOvertime('08:00', '18:40').ot2
    });
    expect(calculateDailyOvertimePay('08:00', '18:40', 28590)).toBe(
      sharedCalculateDailyOvertimePay('08:00', '18:40', {
        baseHourlyRate: 28590 / constants.STANDARD_WORK_DAYS / constants.STANDARD_WORK_HOURS,
        ot1Multiplier: constants.OT1_MULTIPLIER,
        ot2Multiplier: constants.OT2_MULTIPLIER
      })
    );
  });

  it('calculates monthly salary using the shared calculation path', () => {
    const result = calculateSalary(
      2026,
      4,
      { totalOT1Hours: 1, totalOT2Hours: 0 },
      28590,
      0,
      settings,
      0,
      2500,
      0,
      7
    );

    expect(result).toEqual({
      totalOT1Hours: 1,
      totalOT2Hours: 0,
      totalOvertimePay: 159,
      grossSalary: 31249,
      netSalary: 31249
    });
  });

  it('matches shared gross and net helpers exactly', () => {
    const gross = calculateGrossSalary(30000, 1200, 300, 500, 200);
    expect(gross).toBe(sharedCalculateGrossSalary(30000, 1200, 300, 500, 200));
    expect(calculateNetSalary(gross, 700)).toBe(sharedCalculateNetSalary(gross, 700));
  });

  it('validates records using the shared overtime math', () => {
    expect(
      validateSalaryRecord(
        2026,
        4,
        {
          totalOT1Hours: 1,
          totalOT2Hours: 0,
          totalOvertimePay: 159,
          grossSalary: 31249,
          netSalary: 31249,
          baseSalary: 28590,
          welfareAllowance: 2500,
          housingAllowance: 0
        },
        0,
        settings,
        7
      )
    ).toBe(true);
  });
});
