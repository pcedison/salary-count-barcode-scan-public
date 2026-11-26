/**
 * 假日自動化（不再有每小時計時器）：
 * - 每月 1 日外部排程叫醒時（POST /api/salary-automation/cron-tick）：
 *   1. 補抓人事總處辦公日曆表（今年沒存過就抓；明年 7 月起每月查，存好就不再查），有問題寄信。
 *   2. 月結前把上個月與本月已過去的國定假日補標到員工身上。
 * - 國定假日來源：資料庫裡的人事總處辦公日曆表；該年沒存過才用程式內建清單。
 */
import { toHolidaysForMarking } from '@shared/govOfficeCalendar';
import { getStatutoryHolidaysForMonth, type StatutoryHoliday } from '@shared/taiwanStatutoryHolidays';

import { getHolidayAutomationConfig, type HolidayAutomationConfig } from '../config/holidayAutomation';
import { arePayrollWritesPaused } from '../config/payrollWrites';
import { getSalaryAutomationConfig, isSalaryEmailConfigured } from '../config/salaryAutomation';
import { govCalendarRepository } from '../repositories/govCalendarRepository';
import {
  holidayAutomationRepository,
  type ApplyMarkResult,
  type HolidayMonthContext,
} from '../repositories/holidayAutomationRepository';
import {
  defaultFetchText,
  syncGovOfficeCalendar,
  type GovCalendarSyncDeps,
  type GovCalendarSyncResult,
} from '../services/govCalendarSync';
import {
  getLocalDateKey,
  getPreviousYearMonth,
  parseYearMonth,
  planNationalHolidayMarks,
  type PlannedNationalHolidayMark,
  type YearMonth,
} from '../services/holidayAutomation';
import { sendHolidayReminderEmail } from '../services/salaryEmail';
import { createLogger } from '../utils/logger';

const log = createLogger('holiday-automation');

export interface HolidayAutomationDeps {
  loadMonthContext(target: YearMonth): Promise<HolidayMonthContext>;
  applyNationalHolidayMark(mark: PlannedNationalHolidayMark): Promise<ApplyMarkResult>;
  /** 該月要標的國定假日（官方辦公日曆表優先，沒有就用內建清單）。 */
  loadHolidaysForMonth(target: YearMonth, config: HolidayAutomationConfig): Promise<StatutoryHoliday[]>;
}

export async function loadHolidaysForMonth(
  target: YearMonth,
  config: HolidayAutomationConfig,
  loadYear: (year: number) => Promise<Awaited<ReturnType<typeof govCalendarRepository.getYear>>> = (year) =>
    govCalendarRepository.getYear(year)
): Promise<StatutoryHoliday[]> {
  const prefix = `${target.year}-${String(target.month).padStart(2, '0')}-`;
  const stored = await loadYear(target.year);
  if (stored.length === 0) {
    return getStatutoryHolidaysForMonth(target.year, target.month);
  }
  return toHolidaysForMarking(
    stored.filter((day) => day.date.startsWith(prefix)),
    { includeAdjustedDaysOff: config.includeAdjustedDaysOff }
  );
}

const defaultDeps: HolidayAutomationDeps = {
  loadMonthContext: (target) => holidayAutomationRepository.loadMonthContext(target),
  applyNationalHolidayMark: (mark) => holidayAutomationRepository.applyNationalHolidayMark(mark),
  loadHolidaysForMonth: (target, config) => loadHolidaysForMonth(target, config),
};

export interface HolidaySyncResult {
  created: PlannedNationalHolidayMark[];
  skipped: number;
}

/**
 * 把上個月與本月已經過去的國定假日補標到員工身上。可重複執行（已標過的會跳過）。
 */
export async function syncNationalHolidays(
  now = new Date(),
  config: HolidayAutomationConfig = getHolidayAutomationConfig(),
  deps: HolidayAutomationDeps = defaultDeps
): Promise<HolidaySyncResult> {
  const result: HolidaySyncResult = { created: [], skipped: 0 };
  if (!config.enabled || arePayrollWritesPaused()) {
    return result;
  }

  const today = getLocalDateKey(now, config.timeZone);
  const current = parseYearMonth(today);
  for (const target of [getPreviousYearMonth(current), current]) {
    const [context, statutoryHolidays] = await Promise.all([
      deps.loadMonthContext(target),
      deps.loadHolidaysForMonth(target, config),
    ]);
    const marks = planNationalHolidayMarks({ target, today, ...context, statutoryHolidays });
    for (const mark of marks) {
      const outcome = await deps.applyNationalHolidayMark(mark);
      if (outcome === 'created') {
        result.created.push(mark);
      } else {
        result.skipped += 1;
      }
    }
  }

  if (result.created.length > 0) {
    log.info('National holidays marked automatically', {
      count: result.created.length,
      dates: Array.from(new Set(result.created.map((mark) => mark.date))),
    });
  }
  return result;
}

const defaultCalendarDeps: GovCalendarSyncDeps = {
  fetchText: defaultFetchText,
  loadYear: (year) => govCalendarRepository.getYear(year),
  replaceYear: (year, days) => govCalendarRepository.replaceYear(year, days),
  writesPaused: () => arePayrollWritesPaused(),
  isEmailConfigured: () => isSalaryEmailConfigured(getSalaryAutomationConfig()),
  notify: (input) => sendHolidayReminderEmail(input),
};

/** 由外部排程叫醒時呼叫；關閉假日自動化時什麼都不做。失敗只記 log，不擋月結。 */
export async function syncGovOfficeCalendarIfEnabled(
  now = new Date(),
  config: HolidayAutomationConfig = getHolidayAutomationConfig(),
  deps: GovCalendarSyncDeps = defaultCalendarDeps
): Promise<GovCalendarSyncResult | { skipped: 'disabled' } | { skipped: 'error' }> {
  if (!config.enabled) return { skipped: 'disabled' };
  try {
    return await syncGovOfficeCalendar(now, config.timeZone, deps);
  } catch (error) {
    log.error('Government office calendar sync crashed; continuing', error);
    return { skipped: 'error' };
  }
}
