import { getSalaryAutomationConfig, parseBoolean, parseInteger } from './salaryAutomation';

export interface HolidayAutomationConfig {
  /** 國定假日自動標註＋月底提醒信。預設關閉，上線到新主機時才開。 */
  enabled: boolean;
  timeZone: string;
  /** 每月幾號寄提醒信（1–28，預設 28）。 */
  reminderDay: number;
  /** 當天幾點後寄（0–23，預設 9）。 */
  reminderHour: number;
  intervalMs: number;
}

export function getHolidayAutomationConfig(env: NodeJS.ProcessEnv = process.env): HolidayAutomationConfig {
  return {
    enabled: parseBoolean(env.HOLIDAY_AUTOMATION_ENABLED, false),
    timeZone: getSalaryAutomationConfig(env).timeZone,
    reminderDay: parseInteger(env.HOLIDAY_REMINDER_DAY, 28, { min: 1, max: 28 }),
    reminderHour: parseInteger(env.HOLIDAY_REMINDER_HOUR, 9, { min: 0, max: 23 }),
    intervalMs: parseInteger(env.HOLIDAY_AUTOMATION_INTERVAL_MS, 60 * 60 * 1000, {
      min: 60 * 1000,
      max: 24 * 60 * 60 * 1000,
    }),
  };
}
