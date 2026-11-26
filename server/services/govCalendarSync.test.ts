import { describe, expect, it, vi } from 'vitest';

import type { GovCalendarDay } from '@shared/govOfficeCalendar';

import { GOV_CALENDAR_DATASET_URL, pickCalendarResource, syncGovOfficeCalendar, type GovCalendarSyncDeps } from './govCalendarSync';

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];
function yearCsv(year: number): string {
  const lines = ['﻿西元日期,星期,是否放假,備註'];
  for (let d = new Date(Date.UTC(year, 0, 1)); d.getUTCFullYear() === year; d.setUTCDate(d.getUTCDate() + 1)) {
    const key = d.toISOString().slice(0, 10).replace(/-/g, '');
    const weekday = d.getUTCDay();
    const note = key.endsWith('0101') ? '開國紀念日' : '';
    lines.push(`${key},${WEEKDAYS[weekday]},${weekday === 0 || weekday === 6 || note ? 2 : 0},${note}`);
  }
  return lines.join('\r\n');
}

const URL_2026 = 'https://www.dgpa.gov.tw/FileConversion?filename=dgpa/files/a.csv';
const URL_2027 = 'https://www.dgpa.gov.tw/FileConversion?filename=dgpa/files/b.csv';
const URL_2027_FIX = 'https://www.dgpa.gov.tw/FileConversion?filename=dgpa/files/c.csv';

function dataset(items: Array<[string, string]>): string {
  return JSON.stringify({
    success: true,
    result: { distribution: items.map(([resourceDescription, resourceDownloadUrl]) => ({ resourceDescription, resourceDownloadUrl })) },
  });
}

function makeDeps(options: {
  dataset?: string;
  files?: Record<string, string>;
  stored?: Record<number, GovCalendarDay[]>;
  paused?: boolean;
} = {}): GovCalendarSyncDeps & { saved: Map<number, GovCalendarDay[]> } {
  const saved = new Map<number, GovCalendarDay[]>();
  const files: Record<string, string> = {
    [GOV_CALENDAR_DATASET_URL]: options.dataset ?? dataset([
      ['115年中華民國政府行政機關辦公日曆表', URL_2026],
      ['115年中華民國政府行政機關辦公日曆表_Google行事曆專用', 'https://www.dgpa.gov.tw/google.csv'],
      ['116年中華民國政府行政機關辦公日曆表', URL_2027],
    ]),
    [URL_2026]: yearCsv(2026),
    [URL_2027]: yearCsv(2027),
    ...options.files,
  };
  return {
    saved,
    fetchText: vi.fn(async (url: string) => {
      if (!(url in files)) throw new Error('HTTP 404');
      return files[url];
    }),
    loadYear: vi.fn(async (year: number) => options.stored?.[year] ?? []),
    replaceYear: vi.fn(async (year: number, days: GovCalendarDay[]) => { saved.set(year, days); }),
    writesPaused: () => options.paused ?? false,
    isEmailConfigured: () => true,
    notify: vi.fn(async () => ({})),
  };
}

const stored = (year: number): GovCalendarDay[] => [{ date: `${year}-01-01`, isHoliday: true, note: '開國紀念日' }];
// 台北時間 1 日 01:20
const at = (iso: string) => new Date(`${iso}T01:20:00+08:00`);

describe('pickCalendarResource', () => {
  it('picks the plain calendar, prefers the latest revision, ignores Google files and other hosts', () => {
    const items = [
      { resourceDescription: '116年中華民國政府行政機關辦公日曆表', resourceDownloadUrl: URL_2027 },
      { resourceDescription: '116年中華民國政府行政機關辦公日曆表_Google行事曆專用', resourceDownloadUrl: URL_2027 },
      { resourceDescription: '116年中華民國政府行政機關辦公日曆表(1161020更新)', resourceDownloadUrl: URL_2027_FIX },
    ];
    expect(pickCalendarResource(items, 2027)?.url).toBe(URL_2027_FIX);
    expect(pickCalendarResource(items, 2028)).toBeUndefined();
    expect(() => pickCalendarResource([{ resourceDescription: '116年中華民國政府行政機關辦公日曆表', resourceDownloadUrl: 'https://evil.example/x.csv' }], 2027)).toThrow(/人事總處/);
    expect(() => pickCalendarResource(undefined, 2027)).toThrow();
  });
});

describe('syncGovOfficeCalendar', () => {
  it('before July: only fills in this year when missing, does not look at next year', async () => {
    const deps = makeDeps();
    const result = await syncGovOfficeCalendar(at('2026-06-01'), 'Asia/Taipei', deps);
    expect(result.years).toEqual([
      expect.objectContaining({ year: 2026, status: 'updated' }),
      { year: 2027, status: 'not_due' },
    ]);
    expect(deps.saved.get(2026)?.[0]).toEqual({ date: '2026-01-01', isHoliday: true, note: '開國紀念日' });
    expect(result.problems).toEqual([]);
  });

  it('from July: fetches and stores next year once it is published', async () => {
    const deps = makeDeps({ stored: { 2026: stored(2026) } });
    const result = await syncGovOfficeCalendar(at('2026-07-01'), 'Asia/Taipei', deps);
    expect(result.years).toEqual([
      { year: 2026, status: 'already_stored', notableDays: 1 },
      expect.objectContaining({ year: 2027, status: 'updated' }),
    ]);
    expect(deps.saved.has(2027)).toBe(true);
    expect(deps.notify).not.toHaveBeenCalled();
  });

  it('stops checking once both years are stored', async () => {
    const deps = makeDeps({ stored: { 2026: stored(2026), 2027: stored(2027) } });
    const result = await syncGovOfficeCalendar(at('2026-09-01'), 'Asia/Taipei', deps);
    expect(deps.fetchText).not.toHaveBeenCalled();
    expect(result.problems).toEqual([]);
  });

  it('waits quietly while next year is not published, then emails on 1 December', async () => {
    const onlyThisYear = dataset([['115年中華民國政府行政機關辦公日曆表', URL_2026]]);
    const august = makeDeps({ dataset: onlyThisYear, stored: { 2026: stored(2026) } });
    expect((await syncGovOfficeCalendar(at('2026-08-01'), 'Asia/Taipei', august)).problems).toEqual([]);
    expect(august.notify).not.toHaveBeenCalled();

    const december = makeDeps({ dataset: onlyThisYear, stored: { 2026: stored(2026) } });
    const result = await syncGovOfficeCalendar(at('2026-12-01'), 'Asia/Taipei', december);
    expect(result.problems).toEqual(['人事總處的 2027 年辦公日曆表還沒上架。']);
    expect(december.notify).toHaveBeenCalledTimes(1);
    expect(result.notified).toBe(true);
  });

  it('emails when the format changes and stores nothing', async () => {
    const deps = makeDeps({ stored: { 2026: stored(2026) }, files: { [URL_2027]: '日期,放假\n20270101,2' } });
    const result = await syncGovOfficeCalendar(at('2026-07-01'), 'Asia/Taipei', deps);
    expect(result.years[1]).toEqual(expect.objectContaining({ year: 2027, status: 'failed' }));
    expect(result.problems[0]).toMatch(/格式和預期不同/);
    expect(deps.replaceYear).not.toHaveBeenCalled();
    const mail = vi.mocked(deps.notify).mock.calls[0][0];
    expect(mail.subject).toContain('國定假日資料自動更新失敗');
    expect(mail.text).toContain('格式和預期不同');
  });

  it('emails when the open-data platform cannot be reached', async () => {
    const deps = makeDeps({ dataset: 'not json' });
    const result = await syncGovOfficeCalendar(at('2026-07-01'), 'Asia/Taipei', deps);
    expect(result.problems[0]).toMatch(/查不到政府資料開放平臺/);
    expect(deps.notify).toHaveBeenCalledTimes(1);
  });

  it('does not write while payroll writes are paused', async () => {
    const deps = makeDeps({ paused: true });
    const result = await syncGovOfficeCalendar(at('2026-07-01'), 'Asia/Taipei', deps);
    expect(result.years.map((y) => y.status)).toEqual(['would_update', 'would_update']);
    expect(deps.replaceYear).not.toHaveBeenCalled();
  });

  it('skips the email when email is not configured', async () => {
    const deps = { ...makeDeps({ dataset: 'not json' }), isEmailConfigured: () => false };
    const result = await syncGovOfficeCalendar(at('2026-07-01'), 'Asia/Taipei', deps);
    expect(result.notified).toBe(false);
    expect(deps.notify).not.toHaveBeenCalled();
  });
});
