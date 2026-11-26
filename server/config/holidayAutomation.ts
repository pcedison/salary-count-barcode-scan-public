import { getSalaryAutomationConfig, parseBoolean } from './salaryAutomation';

export interface HolidayAutomationConfig {
  /** 國定假日自動標註＋每月 1 日更新人事總處辦公日曆表。預設關閉，上線到新主機時才開。 */
  enabled: boolean;
  timeZone: string;
  /**
   * 是否連公務員的補假、調整放假也自動標成國定假日。預設關閉：
   * 民間企業依勞基法由勞資協商，不一定照公務員放。
   */
  includeAdjustedDaysOff: boolean;
}

export function getHolidayAutomationConfig(env: NodeJS.ProcessEnv = process.env): HolidayAutomationConfig {
  return {
    enabled: parseBoolean(env.HOLIDAY_AUTOMATION_ENABLED, false),
    timeZone: getSalaryAutomationConfig(env).timeZone,
    includeAdjustedDaysOff: parseBoolean(env.HOLIDAY_INCLUDE_ADJUSTED_DAYS_OFF, false),
  };
}
