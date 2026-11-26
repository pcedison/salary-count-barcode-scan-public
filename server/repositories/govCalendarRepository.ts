import { eq } from 'drizzle-orm';

import { taiwanHolidays } from '@shared/schema';
import type { GovCalendarDay } from '@shared/govOfficeCalendar';

import { db } from '../db';

/**
 * 把人事總處辦公日曆表裡「值得記」的日子（放假日、補假、補行上班）存進 taiwan_holidays。
 * 一年一批，整批替換：人事總處發修正版時，舊資料會被新版完整取代。
 */
export class DatabaseGovCalendarRepository {
  async getYear(year: number): Promise<GovCalendarDay[]> {
    const rows = await db.select().from(taiwanHolidays).where(eq(taiwanHolidays.year, year));
    return rows
      .map((row) => ({ date: row.holidayDate, isHoliday: row.isHoliday !== false, note: row.holidayName }))
      .sort((a, b) => a.date.localeCompare(b.date));
  }

  async replaceYear(year: number, days: GovCalendarDay[]): Promise<void> {
    await db.transaction(async (tx) => {
      await tx.delete(taiwanHolidays).where(eq(taiwanHolidays.year, year));
      if (days.length === 0) return;
      await tx.insert(taiwanHolidays).values(
        days.map((day) => ({ year, holidayDate: day.date, holidayName: day.note, isHoliday: day.isHoliday }))
      );
    });
  }
}

export const govCalendarRepository = new DatabaseGovCalendarRepository();
