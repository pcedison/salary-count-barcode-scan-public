import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../repositories/holidayAutomationRepository', () => ({ holidayAutomationRepository: {} }));
vi.mock('../services/salaryEmail', () => ({ sendHolidayReminderEmail: vi.fn() }));

import type { HolidayAutomationConfig } from '../config/holidayAutomation';
import {
  resetHolidayReminderStateForTests,
  runHolidayAutomationTick,
  sendMonthlyHolidayReminder,
  syncNationalHolidays,
  type HolidayAutomationDeps,
} from './holiday-automation-scheduler';

const config: HolidayAutomationConfig = {
  enabled: true,
  timeZone: 'Asia/Taipei',
  reminderDay: 28,
  reminderHour: 9,
  intervalMs: 3_600_000,
};

function makeDeps(overrides: Partial<HolidayAutomationDeps> = {}): HolidayAutomationDeps {
  return {
    loadMonthContext: vi.fn(async () => ({
      employees: [{ id: 1, name: '阿明', active: true, deletedAt: null }] as never,
      attendance: [{ employeeId: 1, date: '2026/12/01', clockIn: '08:00', clockOut: '17:00', isHoliday: false }] as never,
      holidayRows: [],
      settledEmployeeIds: new Set<number>(),
    })),
    applyNationalHolidayMark: vi.fn(async () => 'created' as const),
    sendReminder: vi.fn(async () => ({})),
    isEmailConfigured: () => true,
    ...overrides,
  };
}

beforeEach(() => resetHolidayReminderStateForTests());
afterEach(() => vi.unstubAllEnvs());

describe('syncNationalHolidays', () => {
  it('marks past holidays of last and current month', async () => {
    const deps = makeDeps();
    const result = await syncNationalHolidays(new Date('2026-12-26T01:00:00Z'), config, deps);
    expect(deps.loadMonthContext).toHaveBeenCalledWith({ year: 2026, month: 11 });
    expect(deps.loadMonthContext).toHaveBeenCalledWith({ year: 2026, month: 12 });
    expect(result.created.map((m) => m.date)).toEqual(['2026-12-25']);
  });

  it('does nothing when disabled or payroll writes are paused', async () => {
    const deps = makeDeps();
    await syncNationalHolidays(new Date('2026-12-26T01:00:00Z'), { ...config, enabled: false }, deps);
    vi.stubEnv('PAYROLL_WRITES_PAUSED', 'true');
    await syncNationalHolidays(new Date('2026-12-26T01:00:00Z'), config, deps);
    expect(deps.loadMonthContext).not.toHaveBeenCalled();
  });

  it('counts rows the transaction skipped', async () => {
    const deps = makeDeps({ applyNationalHolidayMark: vi.fn(async () => 'skipped_occupied' as const) });
    const result = await syncNationalHolidays(new Date('2026-12-26T01:00:00Z'), config, deps);
    expect(result).toEqual({ created: [], skipped: 1 });
  });
});

describe('sendMonthlyHolidayReminder', () => {
  it('sends once on the 28th after 9am Taipei time', async () => {
    const deps = makeDeps();
    expect(await sendMonthlyHolidayReminder(new Date('2026-12-28T00:30:00Z'), config, deps)).toBe('not_due'); // 08:30
    expect(await sendMonthlyHolidayReminder(new Date('2026-12-27T02:00:00Z'), config, deps)).toBe('not_due');
    expect(await sendMonthlyHolidayReminder(new Date('2026-12-28T01:00:00Z'), config, deps)).toBe('sent');
    expect(await sendMonthlyHolidayReminder(new Date('2026-12-28T02:00:00Z'), config, deps)).toBe('already_sent');
    expect(deps.sendReminder).toHaveBeenCalledTimes(1);
    const sent = vi.mocked(deps.sendReminder).mock.calls[0][0];
    expect(sent.subject).toContain('2026年12月假日標註確認');
    expect(sent.text).toContain('2027 年會自動標註的日期');
  });

  it('skips without email settings', async () => {
    const deps = makeDeps({ isEmailConfigured: () => false });
    expect(await sendMonthlyHolidayReminder(new Date('2026-12-28T01:00:00Z'), config, deps)).toBe('email_not_configured');
    expect(deps.sendReminder).not.toHaveBeenCalled();
  });
});

describe('runHolidayAutomationTick', () => {
  it('does no work when background services are disabled', async () => {
    vi.stubEnv('APP_BACKGROUND_SERVICES', 'disabled');
    const deps = makeDeps();
    await runHolidayAutomationTick(new Date('2026-12-28T01:00:00Z'), config, deps);
    expect(deps.loadMonthContext).not.toHaveBeenCalled();
  });
});
