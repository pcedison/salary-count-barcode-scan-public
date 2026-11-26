import { describe, expect, it, vi } from 'vitest';

vi.mock('../db', () => ({ db: {} }));
vi.mock('../repositories/govCalendarRepository', () => ({ govCalendarRepository: {} }));
vi.mock('../repositories/holidayAutomationRepository', () => ({ holidayAutomationRepository: {} }));
vi.mock('../repositories/payrollReviewRepository', () => ({ payrollReviewRepository: {} }));
vi.mock('./holiday-automation-scheduler', () => ({ loadHolidaysForMonth: vi.fn() }));

import type { PayrollReview } from '@shared/schema';

import { runPrepayrollReviewGate, type PrepayrollReviewDeps } from './prepayroll-review';

// 12/1 01:20（台灣時間）→ 檢查 11 月。
const NOW = new Date('2026-11-30T17:20:00.000Z');

function review(overrides: Partial<PayrollReview> = {}): PayrollReview {
  return {
    id: 7,
    salaryYear: 2026,
    salaryMonth: 11,
    status: 'pending',
    findings: [{ kind: 'unmarked_rest_day_work', date: '2026-11-14' }],
    emailText: '內文',
    notifiedAt: null,
    confirmedAt: null,
    confirmedBy: null,
    createdAt: new Date(),
    ...overrides,
  } as PayrollReview;
}

function deps(overrides: Partial<PrepayrollReviewDeps> = {}): PrepayrollReviewDeps {
  return {
    enabled: () => true,
    writesPaused: () => false,
    loadMonthContext: vi.fn(async () => ({
      employees: [{ id: 1, name: '陳文山', active: true, deletedAt: null }],
      attendance: [
        { employeeId: 1, date: '2026/11/14', clockIn: '08:00', clockOut: '17:00', isHoliday: false, holidayType: null, holidayId: null },
      ],
      holidayRows: [],
      settledEmployeeIds: new Set<number>(),
    })) as unknown as PrepayrollReviewDeps['loadMonthContext'],
    loadNationalHolidays: vi.fn(async () => []),
    loadMakeupWorkdays: vi.fn(async () => []),
    getReview: vi.fn(async () => undefined),
    createPending: vi.fn(async () => review()),
    markNotified: vi.fn(async () => undefined),
    isEmailConfigured: () => true,
    sendEmail: vi.fn(async () => ({})),
    ...overrides,
  };
}

describe('runPrepayrollReviewGate', () => {
  it('pauses payroll, stores the review and emails once when it finds issues', async () => {
    const d = deps();
    const gate = await runPrepayrollReviewGate(NOW, d);
    expect(gate).toMatchObject({ proceed: false, reason: 'awaiting_review', target: { year: 2026, month: 11 }, notified: true });
    expect(d.createPending).toHaveBeenCalledTimes(1);
    expect(d.sendEmail).toHaveBeenCalledWith(expect.objectContaining({
      subject: '2026年11月月結前檢查：有 1 件要確認，月結已暫停',
    }));
    expect(d.markNotified).toHaveBeenCalledWith(7);
  });

  it('does not email again on the 07:20 backup tick once the email went out', async () => {
    const d = deps({ getReview: vi.fn(async () => review({ notifiedAt: new Date() })) });
    const gate = await runPrepayrollReviewGate(NOW, d);
    expect(gate).toMatchObject({ proceed: false, reason: 'awaiting_review', notified: true });
    expect(d.sendEmail).not.toHaveBeenCalled();
    expect(d.loadMonthContext).not.toHaveBeenCalled();
  });

  it('retries the email on the backup tick if the first one failed', async () => {
    const d = deps({ getReview: vi.fn(async () => review()) });
    await runPrepayrollReviewGate(NOW, d);
    expect(d.sendEmail).toHaveBeenCalledTimes(1);
    expect(d.markNotified).toHaveBeenCalledWith(7);
  });

  it('keeps payroll paused when the email fails and leaves it unmarked', async () => {
    const d = deps({ sendEmail: vi.fn(async () => { throw new Error('down'); }) });
    const gate = await runPrepayrollReviewGate(NOW, d);
    expect(gate).toMatchObject({ proceed: false, notified: false });
    expect(d.markNotified).not.toHaveBeenCalled();
  });

  it('keeps payroll paused when email is not configured', async () => {
    const d = deps({ isEmailConfigured: () => false });
    expect(await runPrepayrollReviewGate(NOW, d)).toMatchObject({ proceed: false, notified: false });
    expect(d.sendEmail).not.toHaveBeenCalled();
  });

  it('lets payroll run once the month is confirmed', async () => {
    const d = deps({ getReview: vi.fn(async () => review({ status: 'confirmed' })) });
    expect(await runPrepayrollReviewGate(NOW, d)).toMatchObject({ proceed: true, reason: 'confirmed' });
    expect(d.sendEmail).not.toHaveBeenCalled();
  });

  it('lets payroll run and stores nothing when there are no findings', async () => {
    const d = deps({
      loadMonthContext: vi.fn(async () => ({ employees: [], attendance: [], holidayRows: [], settledEmployeeIds: new Set<number>() })) as unknown as PrepayrollReviewDeps['loadMonthContext'],
    });
    expect(await runPrepayrollReviewGate(NOW, d)).toMatchObject({ proceed: true, reason: 'clear' });
    expect(d.createPending).not.toHaveBeenCalled();
  });

  it('does nothing in standby while payroll writes are paused', async () => {
    const d = deps({ writesPaused: () => true });
    expect(await runPrepayrollReviewGate(NOW, d)).toMatchObject({ proceed: true, reason: 'writes_paused' });
    expect(d.getReview).not.toHaveBeenCalled();
    expect(d.sendEmail).not.toHaveBeenCalled();
  });

  it('does nothing when switched off', async () => {
    const d = deps({ enabled: () => false });
    expect(await runPrepayrollReviewGate(NOW, d)).toMatchObject({ proceed: true, reason: 'disabled' });
    expect(d.getReview).not.toHaveBeenCalled();
  });

  it('lets payroll run if the check itself cannot run (for example the table is missing)', async () => {
    const d = deps({ getReview: vi.fn(async () => { throw new Error('relation "payroll_reviews" does not exist'); }) });
    expect(await runPrepayrollReviewGate(NOW, d)).toMatchObject({ proceed: true, reason: 'unavailable' });
  });
});
