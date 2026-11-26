/**
 * 行政院人事行政總處「中華民國政府行政機關辦公日曆表」（政府資料開放平臺 dataset 14718）。
 *
 * CSV 欄位：西元日期（YYYYMMDD）、星期、是否放假（0 上班、2 放假）、備註。
 * 一年一檔、每天一列。人事總處每年 6 月底前（最晚 8 月底）公告下一年度，年中也可能發修正版。
 *
 * 這裡只做「讀檔＋檢查格式＋分類」，不碰網路與資料庫。
 */
import type { StatutoryHoliday } from './taiwanStatutoryHolidays';

export interface GovCalendarDay {
  /** YYYY-MM-DD */
  date: string;
  isHoliday: boolean;
  note: string;
}

export class GovCalendarFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GovCalendarFormatError';
  }
}

const EXPECTED_HEADER = ['西元日期', '星期', '是否放假', '備註'];

function splitCsvLine(line: string): string[] {
  const cells: string[] = [];
  let current = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (quoted) {
      if (char === '"' && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        current += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      cells.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  cells.push(current);
  return cells.map((cell) => cell.trim());
}

function daysInYear(year: number): number {
  return new Date(Date.UTC(year, 1, 29)).getUTCMonth() === 1 ? 366 : 365;
}

/**
 * 解析並嚴格檢查一整年的辦公日曆表。格式不符（欄位改名、少天、日期跨年、放假欄位出現 0/2 以外的值）
 * 一律丟 GovCalendarFormatError，讓呼叫端寄信通知，而不是存進半套資料。
 */
export function parseGovOfficeCalendarCsv(csv: string, expectedYear: number): GovCalendarDay[] {
  const lines = csv
    .replace(/^﻿/, '')
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '');
  if (lines.length === 0) {
    throw new GovCalendarFormatError('辦公日曆表是空的');
  }

  const header = splitCsvLine(lines[0]);
  if (EXPECTED_HEADER.some((name, index) => header[index] !== name)) {
    throw new GovCalendarFormatError(`欄位和預期不同：${header.join(',')}`);
  }

  const days: GovCalendarDay[] = [];
  const seen = new Set<string>();
  for (const [index, line] of lines.slice(1).entries()) {
    const [rawDate, , rawFlag, note = ''] = splitCsvLine(line);
    const match = /^(\d{4})(\d{2})(\d{2})$/.exec(rawDate ?? '');
    if (!match) {
      throw new GovCalendarFormatError(`第 ${index + 2} 列日期格式不對：${rawDate}`);
    }
    const [, year, month, day] = match;
    if (Number(year) !== expectedYear) {
      throw new GovCalendarFormatError(`第 ${index + 2} 列不是 ${expectedYear} 年：${rawDate}`);
    }
    const date = `${year}-${month}-${day}`;
    const parsed = new Date(`${date}T00:00:00Z`);
    if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
      throw new GovCalendarFormatError(`第 ${index + 2} 列日期不存在：${rawDate}`);
    }
    if (rawFlag !== '0' && rawFlag !== '2') {
      throw new GovCalendarFormatError(`第 ${index + 2} 列「是否放假」不是 0 或 2：${rawFlag}`);
    }
    if (seen.has(date)) {
      throw new GovCalendarFormatError(`日期重複：${date}`);
    }
    seen.add(date);
    days.push({ date, isHoliday: rawFlag === '2', note });
  }

  if (days.length !== daysInYear(expectedYear)) {
    throw new GovCalendarFormatError(
      `${expectedYear} 年應有 ${daysInYear(expectedYear)} 天，檔案只有 ${days.length} 天`
    );
  }
  return days.sort((a, b) => a.date.localeCompare(b.date));
}

function weekdayOf(date: string): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

export type GovCalendarDayKind =
  /** 有名稱的放假日（紀念日、節日），含落在週末的。 */
  | 'named_holiday'
  /** 公務員的補假、調整放假，或平日放假但沒寫原因。 */
  | 'adjusted_day_off'
  /** 週末但要上班（補行上班）。 */
  | 'makeup_workday'
  | 'regular';

const ADJUSTED_NOTE = /補假|調整放假|彈性放假/;
const MAKEUP_NOTE = /補行上班|補班/;

export function classifyGovCalendarDay(day: GovCalendarDay): GovCalendarDayKind {
  const weekend = [0, 6].includes(weekdayOf(day.date));
  if (!day.isHoliday) {
    return weekend || MAKEUP_NOTE.test(day.note) ? 'makeup_workday' : 'regular';
  }
  if (day.note && !ADJUSTED_NOTE.test(day.note)) return 'named_holiday';
  if (day.note || !weekend) return 'adjusted_day_off';
  return 'regular';
}

/** 只存「不是普通平日／普通週末」的日子，資料庫一年幾十列。 */
export function selectNotableGovCalendarDays(days: GovCalendarDay[]): GovCalendarDay[] {
  return days.filter((day) => classifyGovCalendarDay(day) !== 'regular');
}

export interface GovCalendarHolidayOptions {
  /** 是否把公務員的補假、調整放假也當成要標的假日。 */
  includeAdjustedDaysOff: boolean;
}

/** 轉成假日自動標註用的清單（名稱沿用備註；沒寫的叫「調整放假」）。 */
export function toHolidaysForMarking(
  days: GovCalendarDay[],
  options: GovCalendarHolidayOptions
): StatutoryHoliday[] {
  return days
    .filter((day) => {
      const kind = classifyGovCalendarDay(day);
      return kind === 'named_holiday' || (options.includeAdjustedDaysOff && kind === 'adjusted_day_off');
    })
    .map((day) => ({ date: day.date, name: day.note || '調整放假' }));
}

/** 西元年 → 檔名用的民國年（2027 → 116）。 */
export function toRocYear(year: number): number {
  return year - 1911;
}
