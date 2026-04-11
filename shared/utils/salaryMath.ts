import { constants as sharedConstants } from '../constants';

export interface SalaryMathSettings {
  baseHourlyRate: number;
  ot1Multiplier: number;
  ot2Multiplier: number;
  baseMonthSalary?: number;
  welfareAllowance?: number;
}

export interface OvertimeHoursLike {
  totalOT1Hours: number;
  totalOT2Hours: number;
}

export interface OvertimeBreakdown {
  ot1: number;
  ot2: number;
  total: number;
}

export interface DailyOvertimeSummary extends OvertimeBreakdown {
  pay: number;
}

export const DEFAULT_BASE_MONTH_SALARY =
  sharedConstants.BASE_HOURLY_RATE * sharedConstants.STANDARD_WORK_DAYS * sharedConstants.STANDARD_WORK_HOURS;

const WORK_START_MINUTES = 8 * 60;
const STANDARD_END_MINUTES = 16 * 60;
const OT1_THRESHOLD_MINUTES = {
  start: 10,
  halfHour: 35,
  oneHour: 70,
  oneHalf: 95,
  twoHours: 130
};
const OT2_ROUNDING_STEP_MINUTES = 30;

export function normalizeSalarySettings(settings?: Partial<SalaryMathSettings>): SalaryMathSettings {
  return {
    baseHourlyRate: settings?.baseHourlyRate ?? sharedConstants.BASE_HOURLY_RATE,
    ot1Multiplier: settings?.ot1Multiplier ?? sharedConstants.OT1_MULTIPLIER,
    ot2Multiplier: settings?.ot2Multiplier ?? sharedConstants.OT2_MULTIPLIER,
    baseMonthSalary: settings?.baseMonthSalary ?? DEFAULT_BASE_MONTH_SALARY,
    welfareAllowance: settings?.welfareAllowance ?? sharedConstants.DEFAULT_WELFARE_ALLOWANCE
  };
}

export function timeToMinutes(timeStr: string): number {
  if (!timeStr || !timeStr.includes(':')) return 0;

  const [hours, minutes] = timeStr.split(':').map(Number);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) {
    return 0;
  }

  return hours * 60 + minutes;
}

export function calculateOvertime(clockIn: string, clockOut: string): OvertimeBreakdown {
  if (!clockIn || !clockOut) {
    return { ot1: 0, ot2: 0, total: 0 };
  }

  let inTime = timeToMinutes(clockIn);
  const outTime = timeToMinutes(clockOut);

  if (inTime < WORK_START_MINUTES) {
    inTime = WORK_START_MINUTES;
  }

  let totalMinutes = outTime - inTime;
  if (totalMinutes < 0) {
    totalMinutes += 24 * 60;
  }

  const totalHours = totalMinutes / 60;
  const overtimeMinutes = outTime - STANDARD_END_MINUTES;

  let ot1 = 0;
  let ot2 = 0;

  if (overtimeMinutes >= OT1_THRESHOLD_MINUTES.start) {
    if (overtimeMinutes <= OT1_THRESHOLD_MINUTES.halfHour) {
      ot1 = 0.5;
    } else if (overtimeMinutes <= OT1_THRESHOLD_MINUTES.oneHour) {
      ot1 = 1.0;
    } else if (overtimeMinutes <= OT1_THRESHOLD_MINUTES.oneHalf) {
      ot1 = 1.5;
    } else if (overtimeMinutes <= OT1_THRESHOLD_MINUTES.twoHours) {
      ot1 = 2.0;
    } else {
      ot1 = 2.0;
      const ot2Minutes = overtimeMinutes - OT1_THRESHOLD_MINUTES.twoHours;
      ot2 = Math.ceil(ot2Minutes / OT2_ROUNDING_STEP_MINUTES) * 0.5;
    }
  }

  return {
    ot1,
    ot2,
    total: Number(totalHours.toFixed(1))
  };
}

export function calculateOvertimePay(
  overtimeHours: OvertimeHoursLike,
  settings: Partial<SalaryMathSettings>
): number {
  const normalizedSettings = normalizeSalarySettings(settings);
  const ot1HourlyRate = normalizedSettings.baseHourlyRate * normalizedSettings.ot1Multiplier;
  const ot2HourlyRate = normalizedSettings.baseHourlyRate * normalizedSettings.ot2Multiplier;

  return Math.round(overtimeHours.totalOT1Hours * ot1HourlyRate) + Math.round(overtimeHours.totalOT2Hours * ot2HourlyRate);
}

export function calculateDailyOvertimePay(
  clockIn: string,
  clockOut: string,
  settings: Partial<SalaryMathSettings>
): number {
  const overtime = calculateOvertime(clockIn, clockOut);
  return calculateOvertimePay(
    { totalOT1Hours: overtime.ot1, totalOT2Hours: overtime.ot2 },
    settings
  );
}

export function calculateDailyOvertimeSummary(
  clockIn: string,
  clockOut: string,
  settings: Partial<SalaryMathSettings>
): DailyOvertimeSummary {
  const overtime = calculateOvertime(clockIn, clockOut);

  return {
    ...overtime,
    pay: calculateOvertimePay(
      { totalOT1Hours: overtime.ot1, totalOT2Hours: overtime.ot2 },
      settings
    )
  };
}

export function calculateGrossSalary(
  baseSalary: number,
  overtimePay: number,
  holidayPay: number = 0,
  welfareAllowance: number = 0,
  housingAllowance: number = 0
): number {
  return baseSalary + overtimePay + holidayPay + welfareAllowance + housingAllowance;
}

export function calculateNetSalary(
  grossSalary: number,
  totalDeductions: number
): number {
  return grossSalary - totalDeductions;
}
