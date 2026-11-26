/**
 * 月結前檢查的流程控制（自動月結前呼叫）：
 * - 上個月已確認過 → 照常月結。
 * - 已有待確認紀錄 → 不月結；還沒寄過信才補寄（07:20 備援那次不重寄）。
 * - 第一次檢查：沒疑點就照常月結；有疑點就存成待確認、寄信、不月結。
 * - 讀寫失敗（例如資料表還沒建）只記 log、照常月結，不讓整個月結卡住。
 */
import type { PayrollReview } from '@shared/schema';
import type { StatutoryHoliday } from '@shared/taiwanStatutoryHolidays';

import { getHolidayAutomationConfig } from '../config/holidayAutomation';
import { getPayrollReviewConfig } from '../config/payrollReview';
import { arePayrollWritesPaused } from '../config/payrollWrites';
import { getSalaryAutomationConfig, isSalaryEmailConfigured } from '../config/salaryAutomation';
import { govCalendarRepository } from '../repositories/govCalendarRepository';
import { holidayAutomationRepository, type HolidayMonthContext } from '../repositories/holidayAutomationRepository';
import { payrollReviewRepository, type PayrollReviewTarget } from '../repositories/payrollReviewRepository';
import { getPreviousSalaryMonthTarget } from '../services/monthlySalaryAutomation';
import { buildPrepayrollReview } from '../services/prepayrollReview';
import { sendHolidayReminderEmail } from '../services/salaryEmail';
import { createLogger } from '../utils/logger';
import { loadHolidaysForMonth } from './holiday-automation-scheduler';

const log = createLogger('prepayroll-review');

export type PrepayrollGate =
  | { proceed: true; reason: 'disabled' | 'writes_paused' | 'clear' | 'confirmed' | 'unavailable'; target: PayrollReviewTarget }
  | { proceed: false; reason: 'awaiting_review'; target: PayrollReviewTarget; findingCount: number; notified: boolean };

export interface PrepayrollReviewDeps {
  enabled(): boolean;
  writesPaused(): boolean;
  loadMonthContext(target: PayrollReviewTarget): Promise<HolidayMonthContext>;
  loadNationalHolidays(target: PayrollReviewTarget): Promise<StatutoryHoliday[]>;
  loadMakeupWorkdays(target: PayrollReviewTarget): Promise<string[]>;
  getReview(target: PayrollReviewTarget): Promise<PayrollReview | undefined>;
  createPending(target: PayrollReviewTarget, findings: unknown[], emailText: string): Promise<PayrollReview>;
  markNotified(id: number): Promise<void>;
  isEmailConfigured(): boolean;
  sendEmail(input: { target: PayrollReviewTarget; subject: string; text: string }): Promise<unknown>;
}

function monthPrefix(target: PayrollReviewTarget): string {
  return `${target.year}-${String(target.month).padStart(2, '0')}-`;
}

export const defaultPrepayrollReviewDeps: PrepayrollReviewDeps = {
  enabled: () => getPayrollReviewConfig().enabled,
  writesPaused: () => arePayrollWritesPaused(),
  loadMonthContext: (target) => holidayAutomationRepository.loadMonthContext(target),
  loadNationalHolidays: (target) => loadHolidaysForMonth(target, getHolidayAutomationConfig()),
  loadMakeupWorkdays: async (target) =>
    (await govCalendarRepository.getYear(target.year))
      .filter((day) => !day.isHoliday && day.date.startsWith(monthPrefix(target)))
      .map((day) => day.date),
  getReview: (target) => payrollReviewRepository.getReview(target),
  createPending: (target, findings, emailText) => payrollReviewRepository.createPending(target, findings, emailText),
  markNotified: (id) => payrollReviewRepository.markNotified(id),
  isEmailConfigured: () => isSalaryEmailConfigured(getSalaryAutomationConfig()),
  sendEmail: (input) => sendHolidayReminderEmail(input),
};

function subjectFor(target: PayrollReviewTarget, findingCount: number): string {
  return `${target.year}年${target.month}月月結前檢查：有 ${findingCount} 件要確認，月結已暫停`;
}

async function notify(
  review: PayrollReview,
  target: PayrollReviewTarget,
  deps: PrepayrollReviewDeps
): Promise<boolean> {
  if (!deps.isEmailConfigured()) {
    log.error('Pre-payroll review found issues but email is not configured; payroll stays paused', { target });
    return false;
  }
  try {
    await deps.sendEmail({
      target,
      subject: subjectFor(target, review.findings.length),
      text: review.emailText ?? '',
    });
    await deps.markNotified(review.id);
    return true;
  } catch (error) {
    log.error('Pre-payroll review email failed; will retry on the next tick', error);
    return false;
  }
}

export async function runPrepayrollReviewGate(
  now = new Date(),
  deps: PrepayrollReviewDeps = defaultPrepayrollReviewDeps
): Promise<PrepayrollGate> {
  const target = getPreviousSalaryMonthTarget(now, getSalaryAutomationConfig().timeZone);
  if (!deps.enabled()) return { proceed: true, reason: 'disabled', target };
  // 備援模式：月結本身也不會寫入，這裡不存狀態、不寄信。
  if (deps.writesPaused()) return { proceed: true, reason: 'writes_paused', target };

  try {
    const existing = await deps.getReview(target);
    if (existing?.status === 'confirmed') return { proceed: true, reason: 'confirmed', target };
    if (existing) {
      const notified = existing.notifiedAt != null || (await notify(existing, target, deps));
      return { proceed: false, reason: 'awaiting_review', target, findingCount: existing.findings.length, notified };
    }

    const [context, nationalHolidays, makeupWorkdays] = await Promise.all([
      deps.loadMonthContext(target),
      deps.loadNationalHolidays(target),
      deps.loadMakeupWorkdays(target),
    ]);
    const report = buildPrepayrollReview({ target, ...context, nationalHolidays, makeupWorkdays });
    if (report.findings.length === 0) return { proceed: true, reason: 'clear', target };

    const review = await deps.createPending(target, report.findings, report.text);
    if (review.status === 'confirmed') return { proceed: true, reason: 'confirmed', target };
    const notified = review.notifiedAt != null || (await notify(review, target, deps));
    log.warn('Pre-payroll review found issues; monthly payroll paused until confirmed', {
      target,
      findingCount: review.findings.length,
    });
    return { proceed: false, reason: 'awaiting_review', target, findingCount: review.findings.length, notified };
  } catch (error) {
    log.error('Pre-payroll review could not run; continuing with payroll', error);
    return { proceed: true, reason: 'unavailable', target };
  }
}
