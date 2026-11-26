import { getSalaryAutomationConfig } from '../config/salaryAutomation';
import {
  runMonthlySalaryAutomation,
  shouldRunMonthlySalaryAutomation,
} from '../services/monthlySalaryAutomation';
import { createLogger } from '../utils/logger';
import { areBackgroundServicesEnabled } from '../config/runtimeMode';
import { getHolidayAutomationConfig } from '../config/holidayAutomation';

export interface RuntimeStoppable {
  stop(): void;
}

const log = createLogger('monthly-salary-scheduler');

/**
 * 月結前先補抓人事總處辦公日曆表（有問題會寄信），再補標上個月的國定假日。
 * 失敗只記 log，不擋月結。
 */
async function syncHolidaysBeforePayroll(now: Date): Promise<void> {
  if (!getHolidayAutomationConfig().enabled) return;
  try {
    const { syncGovOfficeCalendarIfEnabled, syncNationalHolidays } = await import('./holiday-automation-scheduler');
    await syncGovOfficeCalendarIfEnabled(now);
    await syncNationalHolidays(now);
  } catch (error) {
    log.error('National holiday sync before payroll failed; continuing with payroll', error);
  }
}

let schedulerHandle: NodeJS.Timeout | null = null;
let running = false;

export type ScheduledMonthlySalaryOutcome =
  | { ran: false; reason: 'not_due' | 'already_running' | 'background_disabled' }
  | { ran: false; reason: 'awaiting_review'; target: { year: number; month: number } }
  | {
      ran: true;
      status: 'succeeded' | 'skipped' | 'failed' | 'dry-run';
      reason?: string;
      target: { year: number; month: number };
    };

export interface ScheduledRunOptions {
  /** cron：外部排程（Cloud Scheduler）叫醒；in_process：程式內計時器。 */
  trigger?: 'cron' | 'in_process';
}

/**
 * 跑一次「該不該月結、該就月結」。程式內計時器受背景服務開關限制（Cloud Run 模式預設關閉）；
 * 外部排程（POST /api/salary-automation/cron-tick）由單一排程叫醒，不受這個開關限制。
 */
export async function runScheduledMonthlySalaryAutomation(
  now = new Date(),
  options: ScheduledRunOptions = {}
): Promise<ScheduledMonthlySalaryOutcome> {
  if (options.trigger !== 'cron' && !areBackgroundServicesEnabled()) {
    return { ran: false, reason: 'background_disabled' };
  }
  const config = getSalaryAutomationConfig();
  if (!shouldRunMonthlySalaryAutomation(now, config)) {
    return { ran: false, reason: 'not_due' };
  }

  if (running) {
    log.warn('Monthly salary automation is already running; skipping this tick');
    return { ran: false, reason: 'already_running' };
  }

  running = true;
  try {
    await syncHolidaysBeforePayroll(now);
    const { runPrepayrollReviewGate } = await import('./prepayroll-review');
    const gate = await runPrepayrollReviewGate(now);
    if (!gate.proceed) {
      log.warn('Monthly salary automation paused for pre-payroll review', { target: gate.target, findingCount: gate.findingCount });
      return { ran: false, reason: 'awaiting_review', target: gate.target };
    }
    const result = await runMonthlySalaryAutomation({ now, config });
    if (result.status === 'failed') {
      log.error('Scheduled monthly salary automation failed', result.reason);
      return { ran: true, status: result.status, reason: result.reason, target: result.target };
    }

    log.info('Scheduled monthly salary automation finished', {
      target: result.target,
      status: result.status,
      recordCount: result.persistedRecords.length,
      skippedCount: result.skippedEmployees.length,
    });
    return { ran: true, status: result.status, reason: result.reason, target: result.target };
  } finally {
    running = false;
  }
}

export function startMonthlySalaryScheduler(): RuntimeStoppable {
  if (!areBackgroundServicesEnabled()) return { stop() {} };
  const config = getSalaryAutomationConfig();
  if (!config.enabled) {
    log.info('Monthly salary scheduler is disabled');
    return { stop() {} };
  }

  if (schedulerHandle) {
    log.warn('Monthly salary scheduler already running; reusing existing handle');
    return {
      stop() {
        stopMonthlySalaryScheduler();
      },
    };
  }

  void runScheduledMonthlySalaryAutomation().catch((error) => {
    log.error('Initial monthly salary automation tick failed', error);
  });

  schedulerHandle = setInterval(() => {
    void runScheduledMonthlySalaryAutomation().catch((error) => {
      log.error('Scheduled monthly salary automation tick failed', error);
    });
  }, config.intervalMs);

  return {
    stop() {
      stopMonthlySalaryScheduler();
    },
  };
}

export function stopMonthlySalaryScheduler(): void {
  if (!schedulerHandle) {
    return;
  }

  clearInterval(schedulerHandle);
  schedulerHandle = null;
}
