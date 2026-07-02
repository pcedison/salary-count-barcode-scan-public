import { describe, expect, it } from 'vitest';

import {
  calculateDailyOvertimePay as clientCalculateDailyOvertimePay,
  calculateOvertime as clientCalculateOvertime,
} from '@/lib/salaryCalculations';
import {
  calculateOvertime as sharedCalculateOvertime,
  calculateOvertimePay as sharedCalculateOvertimePay,
  calculateDailyOvertimePay as sharedCalculateDailyOvertimePay,
} from '@shared/utils/salaryMath';
import { calculateSalary as sharedCalculateSalary } from '@shared/calculationModel';
import { constants } from '@shared/constants';

import {
  calculateOvertimePay as serverCalculateOvertimePay,
  calculateSalary as serverCalculateSalary,
} from './salaryCalculator';

const CLOCK_PAIRS: Array<[string, string]> = [
  ['08:00', '16:00'], // no overtime
  ['07:45', '16:09'], // early arrival, below OT1 threshold
  ['08:00', '16:10'], // exactly 0.5h OT1
  ['08:00', '17:10'], // 1h OT1
  ['08:05', '18:10'], // 2h OT1 cap
  ['08:00', '19:45'], // OT1 + OT2
  ['08:00', '21:00'], // deep OT2
];

const SETTINGS_VARIANTS = [
  {
    baseHourlyRate: constants.BASE_HOURLY_RATE,
    ot1Multiplier: constants.OT1_MULTIPLIER,
    ot2Multiplier: constants.OT2_MULTIPLIER,
    baseMonthSalary: 30000,
  },
  {
    baseHourlyRate: 150,
    ot1Multiplier: 1.5,
    ot2Multiplier: 2.0,
    baseMonthSalary: 36000,
    welfareAllowance: 800,
  },
];

const OVERTIME_GRIDS = [
  { totalOT1Hours: 0, totalOT2Hours: 0 },
  { totalOT1Hours: 0.5, totalOT2Hours: 0 },
  { totalOT1Hours: 2, totalOT2Hours: 0 },
  { totalOT1Hours: 2, totalOT2Hours: 1.5 },
  { totalOT1Hours: 14.5, totalOT2Hours: 6 },
];

describe('salary calculation parity (client ≡ server ≡ shared)', () => {
  it('client and shared agree on overtime hour breakdown for every clock pair', () => {
    for (const [clockIn, clockOut] of CLOCK_PAIRS) {
      const shared = sharedCalculateOvertime(clockIn, clockOut);
      const client = clientCalculateOvertime(clockIn, clockOut);

      expect(client, `${clockIn}-${clockOut}`).toEqual({ ot1: shared.ot1, ot2: shared.ot2 });
    }
  });

  it('client daily overtime pay equals shared implementation with derived hourly rate', () => {
    const baseSalary = 30000;
    const hourlyRate =
      baseSalary / constants.STANDARD_WORK_DAYS / constants.STANDARD_WORK_HOURS;

    for (const [clockIn, clockOut] of CLOCK_PAIRS) {
      const expected = sharedCalculateDailyOvertimePay(clockIn, clockOut, {
        baseHourlyRate: hourlyRate,
        ot1Multiplier: constants.OT1_MULTIPLIER,
        ot2Multiplier: constants.OT2_MULTIPLIER,
      });

      expect(
        clientCalculateDailyOvertimePay(clockIn, clockOut, baseSalary),
        `${clockIn}-${clockOut}`,
      ).toBe(expected);
    }
  });

  it('server overtime pay equals shared implementation for every settings/hours combo', () => {
    for (const settings of SETTINGS_VARIANTS) {
      for (const hours of OVERTIME_GRIDS) {
        expect(
          serverCalculateOvertimePay(hours, settings),
          JSON.stringify({ settings, hours }),
        ).toBe(sharedCalculateOvertimePay(hours, settings));
      }
    }
  });

  it('server calculateSalary equals shared calculateSalary end-to-end', () => {
    for (const settings of SETTINGS_VARIANTS) {
      for (const hours of OVERTIME_GRIDS) {
        const serverResult = serverCalculateSalary(
          2026, 5, hours, settings.baseMonthSalary, 1200, settings, 1000, 500, 0, 42,
        );
        const sharedResult = sharedCalculateSalary(
          2026, 5, 42, hours, settings.baseMonthSalary, 1200, settings, 1000, 500, 0,
        );

        expect(serverResult, JSON.stringify({ settings, hours })).toEqual(sharedResult);
      }
    }
  });
});
