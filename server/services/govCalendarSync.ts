/**
 * 每月 1 日排程叫醒時，向政府資料開放平臺查人事行政總處的「政府行政機關辦公日曆表」，
 * 把今年與明年的放假日存進資料庫，國定假日自動標註就改用這份官方資料（寫死的清單只當備援）。
 *
 * - 人事總處每年 6 月底前（最晚 8 月底）公告下一年度。
 *   今年：資料庫沒有就抓一次（第一次上線時補齊）。
 *   明年：7 月起每月 1 日查一次，抓到存好之後就不再查。
 * - 抓不到、格式變了、12 月 1 日明年還沒公告：寄信通知（收件人同月結通知信）。
 * - 下載網址只接受 www.dgpa.gov.tw 的 https 連結，避免平臺資料被改成別的網站。
 */
import {
  GovCalendarFormatError,
  parseGovOfficeCalendarCsv,
  selectNotableGovCalendarDays,
  toRocYear,
  type GovCalendarDay,
} from '@shared/govOfficeCalendar';

import { getLocalDateKey, parseYearMonth, type YearMonth } from './holidayAutomation';
import { createLogger } from '../utils/logger';

const log = createLogger('gov-calendar-sync');

export const GOV_CALENDAR_DATASET_URL = 'https://data.gov.tw/api/v2/rest/dataset/14718';
const ALLOWED_DOWNLOAD_HOST = 'www.dgpa.gov.tw';
const FETCH_TIMEOUT_MS = 20_000;
/** 7 月起開始查明年。 */
export const NEXT_YEAR_CHECK_FROM_MONTH = 7;
/** 到 12 月 1 日明年還沒上架，寄信提醒。 */
const NEXT_YEAR_ALERT_MONTH = 12;

export interface GovCalendarResource {
  description: string;
  url: string;
}

interface DatasetDistribution {
  resourceDescription?: unknown;
  resourceDownloadUrl?: unknown;
}

export type GovCalendarYearStatus =
  | { year: number; status: 'updated'; notableDays: number; source: string }
  | { year: number; status: 'would_update'; notableDays: number; source: string }
  | { year: number; status: 'already_stored'; notableDays: number }
  | { year: number; status: 'not_due' }
  | { year: number; status: 'not_published' }
  | { year: number; status: 'failed'; error: string };

export interface GovCalendarSyncResult {
  years: GovCalendarYearStatus[];
  problems: string[];
  notified: boolean;
}

export interface GovCalendarSyncDeps {
  fetchText(url: string): Promise<string>;
  loadYear(year: number): Promise<GovCalendarDay[]>;
  replaceYear(year: number, days: GovCalendarDay[]): Promise<void>;
  writesPaused(): boolean;
  isEmailConfigured(): boolean;
  notify(input: { target: YearMonth; subject: string; text: string }): Promise<unknown>;
}

export async function defaultFetchText(url: string): Promise<string> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: { Accept: 'application/json, text/csv, */*' },
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return response.text();
}

/** 從資料集的資源清單挑出該年的「一般版」辦公日曆表（不是 Google 行事曆專用版）。同年有多個（修正版）取最後一個。 */
export function pickCalendarResource(distribution: unknown, year: number): GovCalendarResource | undefined {
  if (!Array.isArray(distribution)) {
    throw new GovCalendarFormatError('資料集回應沒有資源清單');
  }
  const prefix = `${toRocYear(year)}年中華民國政府行政機關辦公日曆表`;
  const matches = (distribution as DatasetDistribution[])
    .map((item) => ({ description: String(item.resourceDescription ?? ''), url: String(item.resourceDownloadUrl ?? '') }))
    .filter((item) => item.description.startsWith(prefix) && !/google/i.test(item.description));
  for (const candidate of [...matches].reverse()) {
    try {
      const url = new URL(candidate.url);
      if (url.protocol === 'https:' && url.hostname === ALLOWED_DOWNLOAD_HOST) {
        return candidate;
      }
    } catch {
      // 網址壞掉就看下一個
    }
  }
  if (matches.length > 0) {
    throw new GovCalendarFormatError(`${year} 年的下載網址不是人事總處網站`);
  }
  return undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function syncGovOfficeCalendar(
  now: Date,
  timeZone: string,
  deps: GovCalendarSyncDeps
): Promise<GovCalendarSyncResult> {
  const today = parseYearMonth(getLocalDateKey(now, timeZone));
  const years: GovCalendarYearStatus[] = [];
  const problems: string[] = [];

  // 先看哪些年份需要抓：已經存過的年份不再查。
  const pending: number[] = [];
  for (const year of [today.year, today.year + 1]) {
    if (year > today.year && today.month < NEXT_YEAR_CHECK_FROM_MONTH) {
      years.push({ year, status: 'not_due' });
      continue;
    }
    const stored = await deps.loadYear(year);
    if (stored.length > 0) {
      years.push({ year, status: 'already_stored', notableDays: stored.length });
    } else {
      pending.push(year);
    }
  }

  if (pending.length > 0) {
    let distribution: unknown;
    try {
      const body = await deps.fetchText(GOV_CALENDAR_DATASET_URL);
      distribution = (JSON.parse(body) as { result?: { distribution?: unknown } })?.result?.distribution;
    } catch (error) {
      problems.push(`查不到政府資料開放平臺的辦公日曆表資料集：${errorMessage(error)}`);
      for (const year of pending) years.push({ year, status: 'failed', error: errorMessage(error) });
      pending.length = 0;
    }

    for (const year of pending) {
      try {
        const resource = pickCalendarResource(distribution, year);
        if (!resource) {
          years.push({ year, status: 'not_published' });
          if (year === today.year || today.month >= NEXT_YEAR_ALERT_MONTH) {
            problems.push(`人事總處的 ${year} 年辦公日曆表還沒上架。`);
          }
          continue;
        }
        const days = selectNotableGovCalendarDays(parseGovOfficeCalendarCsv(await deps.fetchText(resource.url), year));
        if (deps.writesPaused()) {
          years.push({ year, status: 'would_update', notableDays: days.length, source: resource.description });
        } else {
          await deps.replaceYear(year, days);
          years.push({ year, status: 'updated', notableDays: days.length, source: resource.description });
          log.info('Government office calendar stored', { year, notableDays: days.length, source: resource.description });
        }
      } catch (error) {
        years.push({ year, status: 'failed', error: errorMessage(error) });
        problems.push(
          error instanceof GovCalendarFormatError
            ? `${year} 年辦公日曆表的格式和預期不同：${error.message}`
            : `${year} 年辦公日曆表下載失敗：${errorMessage(error)}`
        );
      }
    }
  }

  let notified = false;
  if (problems.length > 0) {
    log.warn('Government office calendar sync found problems', { problems });
    if (deps.isEmailConfigured()) {
      try {
        await deps.notify({
          target: today,
          subject: '國定假日資料自動更新失敗，需要你看一下',
          text: [
            '系統每年 7 月起，每月 1 日會向政府資料開放平臺（人事行政總處「政府行政機關辦公日曆表」）查明年的放假日，存好後就不再查。這次有問題：',
            '',
            ...problems.map((problem) => `- ${problem}`),
            '',
            '在修好之前，國定假日自動標註會先用已存的資料；沒有存過的年份改用程式內建清單。',
            '請到 https://data.gov.tw/dataset/14718 確認資料是否正常。',
          ].join('\n'),
        });
        notified = true;
      } catch (error) {
        log.error('Failed to send government calendar alert email', error);
      }
    }
  }

  years.sort((a, b) => a.year - b.year);
  return { years, problems, notified };
}
