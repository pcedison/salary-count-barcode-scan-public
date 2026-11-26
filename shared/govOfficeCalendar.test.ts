import { describe, expect, it } from 'vitest';

import {
  GovCalendarFormatError,
  classifyGovCalendarDay,
  parseGovOfficeCalendarCsv,
  selectNotableGovCalendarDays,
  toHolidaysForMarking,
} from './govOfficeCalendar';

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];

/** 依真實格式產生一整年 CSV：週末放假，overrides 指定特殊日子。 */
function buildYearCsv(year: number, overrides: Record<string, [0 | 2, string]> = {}, bom = true): string {
  const lines = ['西元日期,星期,是否放假,備註'];
  for (let d = new Date(Date.UTC(year, 0, 1)); d.getUTCFullYear() === year; d.setUTCDate(d.getUTCDate() + 1)) {
    const key = d.toISOString().slice(0, 10).replace(/-/g, '');
    const weekday = d.getUTCDay();
    const [flag, note] = overrides[key] ?? [weekday === 0 || weekday === 6 ? 2 : 0, ''];
    lines.push(`${key},${WEEKDAYS[weekday]},${flag},${note}`);
  }
  return `${bom ? '﻿' : ''}${lines.join('\r\n')}\r\n`;
}

describe('parseGovOfficeCalendarCsv', () => {
  it('parses a full year with BOM and CRLF', () => {
    const days = parseGovOfficeCalendarCsv(buildYearCsv(2027, { '20270101': [2, '開國紀念日'] }), 2027);
    expect(days).toHaveLength(365);
    expect(days[0]).toEqual({ date: '2027-01-01', isHoliday: true, note: '開國紀念日' });
    expect(days[3]).toEqual({ date: '2027-01-04', isHoliday: false, note: '' });
  });

  it('handles leap years', () => {
    expect(parseGovOfficeCalendarCsv(buildYearCsv(2028, {}, false), 2028)).toHaveLength(366);
  });

  it('rejects renamed columns, missing days, wrong year and unknown flags', () => {
    const good = buildYearCsv(2027);
    expect(() => parseGovOfficeCalendarCsv(good.replace('是否放假', '放假'), 2027)).toThrow(GovCalendarFormatError);
    expect(() => parseGovOfficeCalendarCsv(good.split('\r\n').slice(0, 300).join('\r\n'), 2027)).toThrow(/365/);
    expect(() => parseGovOfficeCalendarCsv(good, 2026)).toThrow(/2026/);
    expect(() => parseGovOfficeCalendarCsv(good.replace('20270104,一,0', '20270104,一,1'), 2027)).toThrow(/0 或 2/);
    expect(() => parseGovOfficeCalendarCsv('', 2027)).toThrow(GovCalendarFormatError);
  });
});

describe('classification', () => {
  const days = parseGovOfficeCalendarCsv(
    buildYearCsv(2027, {
      '20270101': [2, '開國紀念日'], // 週五
      '20270403': [2, '兒童節'], // 週六
      '20270405': [2, '補假'], // 週一
      '20270208': [2, '調整放假'], // 週一
      '20270209': [2, ''], // 週二，平日放假沒寫原因
      '20270220': [0, '補行上班'], // 週六上班
    }),
    2027
  );
  const byDate = new Map(days.map((day) => [day.date, day]));

  it('sorts days into named holidays, adjusted days off and make-up workdays', () => {
    expect(classifyGovCalendarDay(byDate.get('2027-01-01')!)).toBe('named_holiday');
    expect(classifyGovCalendarDay(byDate.get('2027-04-03')!)).toBe('named_holiday');
    expect(classifyGovCalendarDay(byDate.get('2027-04-05')!)).toBe('adjusted_day_off');
    expect(classifyGovCalendarDay(byDate.get('2027-02-08')!)).toBe('adjusted_day_off');
    expect(classifyGovCalendarDay(byDate.get('2027-02-09')!)).toBe('adjusted_day_off');
    expect(classifyGovCalendarDay(byDate.get('2027-02-20')!)).toBe('makeup_workday');
    expect(classifyGovCalendarDay(byDate.get('2027-01-02')!)).toBe('regular');
    expect(classifyGovCalendarDay(byDate.get('2027-01-04')!)).toBe('regular');
  });

  it('keeps only notable days', () => {
    expect(selectNotableGovCalendarDays(days).map((day) => day.date)).toEqual([
      '2027-01-01', '2027-02-08', '2027-02-09', '2027-02-20', '2027-04-03', '2027-04-05',
    ]);
  });

  it('marks only named holidays unless adjusted days off are included', () => {
    expect(toHolidaysForMarking(days, { includeAdjustedDaysOff: false })).toEqual([
      { date: '2027-01-01', name: '開國紀念日' },
      { date: '2027-04-03', name: '兒童節' },
    ]);
    expect(toHolidaysForMarking(days, { includeAdjustedDaysOff: true }).map((h) => h.name)).toEqual([
      '開國紀念日', '調整放假', '調整放假', '兒童節', '補假',
    ]);
  });
});
