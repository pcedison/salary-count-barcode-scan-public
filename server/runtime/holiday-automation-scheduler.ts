import { getHolidayAutomationConfig, type HolidayAutomationConfig } from '../config/holidayAutomation';
import { arePayrollWritesPaused } from '../config/payrollWrites';
import { areBackgroundServicesEnabled } from '../config/runtimeMode';
import { getSalaryAutomationConfig, isSalaryEmailConfigured } from '../config/salaryAutomation';
import {
  holidayAutomationRepository,
  type ApplyMarkResult,
  type HolidayMonthContext,
} from '../repositories/holidayAutomationRepository';
import {
  buildHolidayReminder,
  getLocalDateKey,
  getLocalHour,
  getNextYearHolidaysForReminder,
  getPreviousYearMonth,
  parseYearMonth,
  planNationalHolidayMarks,
  type PlannedNationalHolidayMark,
  type YearMonth,
} from '../services/holidayAutomation';
import { sendHolidayReminderEmail } from '../services/salaryEmail';
import { createLogger } from '../utils/logger';

import type { RuntimeStoppable } from './line-oauth-cleanup';

const log = createLogger('holiday-automation');

export interface HolidayAutomationDeps {
  loadMonthContext(target: YearMonth): Promise<HolidayMonthContext>;
  applyNationalHolidayMark(mark: PlannedNationalHolidayMark): Promise<ApplyMarkResult>;
  sendReminder(input: { target: YearMonth; subject: string; text: string }): Promise<unknown>;
  isEmailConfigured(): boolean;
}

const defaultDeps: HolidayAutomationDeps = {
  loadMonthContext: (target) => holidayAutomationRepository.loadMonthContext(target),
  applyNationalHolidayMark: (mark) => holidayAutomationRepository.applyNationalHolidayMark(mark),
  sendReminder: (input) => sendHolidayReminderEmail(input),
  isEmailConfigured: () => isSalaryEmailConfigured(getSalaryAutomationConfig()),
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
    const context = await deps.loadMonthContext(target);
    const marks = planNationalHolidayMarks({ target, today, ...context });
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

const sentReminderMonths = new Set<string>();

export function shouldSendHolidayReminder(now: Date, config: HolidayAutomationConfig): boolean {
  if (!config.enabled) return false;
  const today = getLocalDateKey(now, config.timeZone);
  const day = Number(today.slice(8, 10));
  return day === config.reminderDay && getLocalHour(now, config.timeZone) >= config.reminderHour;
}

export async function sendMonthlyHolidayReminder(
  now = new Date(),
  config: HolidayAutomationConfig = getHolidayAutomationConfig(),
  deps: HolidayAutomationDeps = defaultDeps
): Promise<'sent' | 'not_due' | 'already_sent' | 'email_not_configured'> {
  if (!shouldSendHolidayReminder(now, config)) return 'not_due';

  const today = getLocalDateKey(now, config.timeZone);
  const target = parseYearMonth(today);
  const monthKey = today.slice(0, 7);
  if (sentReminderMonths.has(monthKey)) return 'already_sent';

  if (!deps.isEmailConfigured()) {
    log.warn('Holiday reminder skipped: salary email is not configured');
    sentReminderMonths.add(monthKey);
    return 'email_not_configured';
  }

  const context = await deps.loadMonthContext(target);
  const report = buildHolidayReminder({
    target,
    today,
    employees: context.employees,
    attendance: context.attendance,
    holidayRows: context.holidayRows,
    nextYearHolidays: getNextYearHolidaysForReminder(target),
  });
  await deps.sendReminder({ target, subject: report.subject, text: report.text });
  sentReminderMonths.add(monthKey);
  log.info('Holiday reminder sent', {
    month: monthKey,
    unmarkedNoClockInDates: report.unmarkedNoClockInDates,
    workedOnHolidayCount: report.workedOnHoliday.length,
  });
  return 'sent';
}

let running = false;

export async function runHolidayAutomationTick(
  now = new Date(),
  config: HolidayAutomationConfig = getHolidayAutomationConfig(),
  deps: HolidayAutomationDeps = defaultDeps
): Promise<void> {
  if (!areBackgroundServicesEnabled() || !config.enabled) return;
  if (running) {
    log.warn('Holiday automation is already running; skipping this tick');
    return;
  }

  running = true;
  try {
    await syncNationalHolidays(now, config, deps);
    await sendMonthlyHolidayReminder(now, config, deps);
  } finally {
    running = false;
  }
}

let schedulerHandle: NodeJS.Timeout | null = null;

export function startHolidayAutomationScheduler(): RuntimeStoppable {
  if (!areBackgroundServicesEnabled()) return { stop() {} };
  const config = getHolidayAutomationConfig();
  if (!config.enabled) {
    log.info('Holiday automation is disabled');
    return { stop() {} };
  }
  if (schedulerHandle) {
    return { stop: stopHolidayAutomationScheduler };
  }

  const tick = () => {
    void runHolidayAutomationTick().catch((error) => {
      log.error('Holiday automation tick failed', error);
    });
  };
  tick();
  schedulerHandle = setInterval(tick, config.intervalMs);
  return { stop: stopHolidayAutomationScheduler };
}

export function stopHolidayAutomationScheduler(): void {
  if (!schedulerHandle) return;
  clearInterval(schedulerHandle);
  schedulerHandle = null;
}

/** 測試用：清掉「本月已寄」的記憶。 */
export function resetHolidayReminderStateForTests(): void {
  sentReminderMonths.clear();
  running = false;
}
