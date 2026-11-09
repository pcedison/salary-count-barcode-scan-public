/**
 * 勞工國定假日清單（勞基法第 37 條＋《紀念日及節日實施條例》，勞工每年 16 天）。
 *
 * 來源：勞動部「國定假日及補假」頁（2026-05-06 更新版）列出的 12 項紀念日及節日；
 * 農曆節日的西曆日期依當年行政院公布的行事曆核對。
 *
 * 刻意不收錄：
 * - 公務員的「調整放假日」與「補假日」：民間企業不受拘束；國定假日遇勞工例假或休息日時，
 *   補假由勞資雙方另行協商，系統只在提醒信列出、不自動標註。
 * - 選舉、罷免、公投投票日：每次由中央選舉委員會公告，日期不固定，需人工新增。
 *
 * 每年 12 月的假日提醒信會檢查下一年是否已收錄；沒有的話要在這裡補上下一年。
 */
export interface StatutoryHoliday {
  /** YYYY-MM-DD */
  date: string;
  name: string;
}

const HOLIDAYS_BY_YEAR: Record<number, StatutoryHoliday[]> = {
  2026: [
    { date: '2026-01-01', name: '中華民國開國紀念日' },
    { date: '2026-02-15', name: '除夕前一日' },
    { date: '2026-02-16', name: '除夕' },
    { date: '2026-02-17', name: '春節（初一）' },
    { date: '2026-02-18', name: '春節（初二）' },
    { date: '2026-02-19', name: '春節（初三）' },
    { date: '2026-02-28', name: '和平紀念日' },
    { date: '2026-04-04', name: '兒童節' },
    { date: '2026-04-05', name: '清明節' },
    { date: '2026-05-01', name: '勞動節' },
    { date: '2026-06-19', name: '端午節' },
    { date: '2026-09-25', name: '中秋節' },
    { date: '2026-09-28', name: '孔子誕辰紀念日（教師節）' },
    { date: '2026-10-10', name: '國慶日' },
    { date: '2026-10-25', name: '臺灣光復暨金門古寧頭大捷紀念日' },
    { date: '2026-12-25', name: '行憲紀念日' },
  ],
  2027: [
    { date: '2027-01-01', name: '中華民國開國紀念日' },
    { date: '2027-02-04', name: '除夕前一日' },
    { date: '2027-02-05', name: '除夕' },
    { date: '2027-02-06', name: '春節（初一）' },
    { date: '2027-02-07', name: '春節（初二）' },
    { date: '2027-02-08', name: '春節（初三）' },
    { date: '2027-02-28', name: '和平紀念日' },
    { date: '2027-04-04', name: '兒童節' },
    { date: '2027-04-05', name: '清明節' },
    { date: '2027-05-01', name: '勞動節' },
    { date: '2027-06-09', name: '端午節' },
    { date: '2027-09-15', name: '中秋節' },
    { date: '2027-09-28', name: '孔子誕辰紀念日（教師節）' },
    { date: '2027-10-10', name: '國慶日' },
    { date: '2027-10-25', name: '臺灣光復暨金門古寧頭大捷紀念日' },
    { date: '2027-12-25', name: '行憲紀念日' },
  ],
};

/** 回傳該年收錄的國定假日；尚未收錄的年份回傳 undefined（呼叫端要提醒補資料）。 */
export function getStatutoryHolidays(year: number): StatutoryHoliday[] | undefined {
  const list = HOLIDAYS_BY_YEAR[year];
  return list ? list.map((holiday) => ({ ...holiday })) : undefined;
}

export function getStatutoryHolidaysForMonth(year: number, month: number): StatutoryHoliday[] {
  const prefix = `${year}-${String(month).padStart(2, '0')}-`;
  return (getStatutoryHolidays(year) ?? []).filter((holiday) => holiday.date.startsWith(prefix));
}

export function hasStatutoryHolidayYear(year: number): boolean {
  return year in HOLIDAYS_BY_YEAR;
}

/** 0 = 週日 … 6 = 週六（以日期本身計算，不受伺服器時區影響）。 */
export function getWeekdayOfDate(date: string): number {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

export function isWeekendDate(date: string): boolean {
  const weekday = getWeekdayOfDate(date);
  return weekday === 0 || weekday === 6;
}
