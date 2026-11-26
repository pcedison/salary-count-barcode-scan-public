import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../repositories/holidayAutomationRepository', () => ({ holidayAutomationRepository: {} }));
vi.mock('../repositories/govCalendarRepository', () => ({ govCalendarRepository: {} }));
vi.mock('../services/salaryEmail', () => ({ sendHolidayReminderEmail: vi.fn() }));

import type { HolidayAutomationConfig } from '../config/holidayAutomation';
import {
  loadHolidaysForMonth,
  syncGovOfficeCalendarIfEnabled,
  syncNationalHolidays,
  type HolidayAutomationDeps,
} from './holiday-automation-scheduler';

const config: HolidayAutomationConfig = { enabled: true, timeZone: 'Asia/Taipei', includeAdjustedDaysOff: false };

function makeDeps(overrides: Partial<HolidayAutomationDeps> = {}): HolidayAutomationDeps {
  return {
    loadMonthContext: vi.fn(async () => ({
      employees: [{ id: 1, name: '阿明', active: true, deletedAt: null }] as never,
      attendance: [{ employeeId: 1, date: '2026/12/01', clockIn: '08:00', clockOut: '17:00', isHoliday: false }] as never,
      holidayRows: [],
      settledEmployeeIds: new Set<number>(),
    })),
    applyNationalHolidayMark: vi.fn(async () => 'created' as const),
    loadHolidaysForMonth: (target, cfg) => loadHolidaysForMonth(target, cfg, async () => []),
    ...overrides,
  };
}

afterEach(() => vi.unstubAllEnvs());

describe('syncNationalHolidays', () => {
  it('marks past holidays of last and current month (built-in list when nothing is stored)', async () => {
    const deps = makeDeps();
    const result = await syncNationalHolidays(new Date('2026-12-26T01:00:00Z'), config, deps);
    expect(deps.loadMonthContext).toHaveBeenCalledWith({ year: 2026, month: 11 });
    expect(deps.loadMonthContext).toHaveBeenCalledWith({ year: 2026, month: 12 });
    expect(result.created.map((m) => m.date)).toEqual(['2026-12-25']);
  });

  it('uses the stored government calendar when the year has one', async () => {
    const stored = [
      { date: '2026-12-24', isHoliday: true, note: '補假' },
      { date: '2026-12-25', isHoliday: true, note: '行憲紀念日' },
    ];
    const deps = makeDeps({ loadHolidaysForMonth: (target, cfg) => loadHolidaysForMonth(target, cfg, async () => stored) });
    const result = await syncNationalHolidays(new Date('2026-12-26T01:00:00Z'), config, deps);
    expect(result.created.map((m) => `${m.date} ${m.name}`)).toEqual(['2026-12-25 行憲紀念日']);

    const withAdjusted = await syncNationalHolidays(
      new Date('2026-12-26T01:00:00Z'), { ...config, includeAdjustedDaysOff: true }, deps
    );
    expect(withAdjusted.created.map((m) => m.date)).toEqual(['2026-12-24', '2026-12-25']);
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

describe('syncGovOfficeCalendarIfEnabled', () => {
  it('does nothing while holiday automation is off', async () => {
    const fetchText = vi.fn();
    const result = await syncGovOfficeCalendarIfEnabled(new Date(), { ...config, enabled: false }, {
      fetchText, loadYear: vi.fn(), replaceYear: vi.fn(), writesPaused: () => false,
      isEmailConfigured: () => true, notify: vi.fn(),
    });
    expect(result).toEqual({ skipped: 'disabled' });
    expect(fetchText).not.toHaveBeenCalled();
  });

  it('never throws, so payroll still runs', async () => {
    const result = await syncGovOfficeCalendarIfEnabled(new Date('2026-07-01T00:00:00Z'), config, {
      fetchText: vi.fn(), loadYear: vi.fn(async () => { throw new Error('db down'); }), replaceYear: vi.fn(),
      writesPaused: () => false, isEmailConfigured: () => true, notify: vi.fn(),
    });
    expect(result).toEqual({ skipped: 'error' });
  });
});

describe('no hourly timer', () => {
  it('exports no scheduler start function any more', async () => {
    const module = await import('./holiday-automation-scheduler');
    expect('startHolidayAutomationScheduler' in module).toBe(false);
  });
});
