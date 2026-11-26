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

/** 月結前先補標上個月的國定假日；失敗只記 log，不擋月結。 */
async function syncHolidaysBeforePayroll(now: Date): Promise<void> {
  if (!getHolidayAutomationConfig().enabled) return;
  try {
    const { syncNationalHolidays } = await import('./holiday-automation-scheduler');
    await syncNationalHolidays(now);
  } catch (error) {
    log.error('National holiday sync before payroll failed; continuing with payroll', error);
  }
}

let schedulerHandle: NodeJS.Timeout | null = null;
let running = false;

export type ScheduledMonthlySalaryOutcome =
  | { ran: false; reason: 'not_due' | 'already_running' }
  | {
      ran: true;
      status: 'succeeded' | 'skipped' | 'failed' | 'dry-run';
      reason?: string;
      target: { year: number; month: number };
    };

/**
 * 跑一次「該不該月結、該就月結」。由程式內排程（startMonthlySalaryScheduler）或
 * 外部排程（POST /api/salary-automation/cron-tick）呼叫；背景服務開關只管前者。
 */
export async function runScheduledMonthlySalaryAutomation(
  now = new Date()
): Promise<ScheduledMonthlySalaryOutcome> {
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
