import { and, eq, or, sql } from 'drizzle-orm';

import {
  holidays,
  salaryRecords,
  temporaryAttendance,
  type Employee,
  type Holiday,
  type TemporaryAttendance,
} from '@shared/schema';
import { normalizeDateToDash, normalizeDateToSlash } from '@shared/utils/specialLeaveSync';

import { db } from '../db';
import { storage } from '../storage';
import { salaryRepository } from './salaryRepository';
import { AUTO_NATIONAL_HOLIDAY_DESCRIPTION, type PlannedNationalHolidayMark, type YearMonth } from '../services/holidayAutomation';

// 與 storage.upsertTemporaryAttendanceScan 同一把鎖：同一員工的打卡與自動標註互斥。
const ATTENDANCE_LOCK_NAMESPACE = 918273;

export interface HolidayMonthContext {
  employees: Employee[];
  attendance: TemporaryAttendance[];
  holidayRows: Holiday[];
  settledEmployeeIds: Set<number>;
}

export type ApplyMarkResult = 'created' | 'skipped_occupied' | 'skipped_settled';

export class DatabaseHolidayAutomationRepository {
  async loadMonthContext(target: YearMonth): Promise<HolidayMonthContext> {
    const month = String(target.month).padStart(2, '0');
    const [employees, attendance, holidayRows, salaryRows] = await Promise.all([
      storage.getAllEmployees(),
      storage.getTemporaryAttendanceByMonth(target.year, target.month),
      db
        .select()
        .from(holidays)
        .where(sql`(${holidays.date} like ${`${target.year}-${month}-%`} or ${holidays.date} like ${`${target.year}/${month}/%`})`),
      salaryRepository.getSalaryRecordsByYearMonth(target.year, target.month),
    ]);

    return {
      employees,
      attendance,
      holidayRows,
      settledEmployeeIds: new Set(
        salaryRows.map((row) => row.employeeId).filter((id): id is number => id != null)
      ),
    };
  }

  /**
   * 在交易內重新確認後才寫入（假日設定＋考勤紀錄一起成功或一起失敗），
   * 讓計畫產生後才出現的打卡、手動標註或月結都會被尊重。
   */
  async applyNationalHolidayMark(mark: PlannedNationalHolidayMark): Promise<ApplyMarkResult> {
    const slashDate = normalizeDateToSlash(mark.date);
    const dashDate = normalizeDateToDash(mark.date);
    const [year, month] = dashDate.split('-').map(Number);

    return db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(${ATTENDANCE_LOCK_NAMESPACE}, ${mark.employeeId})`);

      const settled = await tx
        .select({ id: salaryRecords.id })
        .from(salaryRecords)
        .where(and(
          eq(salaryRecords.employeeId, mark.employeeId),
          eq(salaryRecords.salaryYear, year),
          eq(salaryRecords.salaryMonth, month)
        ))
        .limit(1);
      if (settled.length > 0) {
        return 'skipped_settled';
      }

      const existingAttendance = await tx
        .select({ id: temporaryAttendance.id })
        .from(temporaryAttendance)
        .where(and(
          eq(temporaryAttendance.employeeId, mark.employeeId),
          or(eq(temporaryAttendance.date, slashDate), eq(temporaryAttendance.date, dashDate))
        ))
        .limit(1);
      const existingHoliday = await tx
        .select({ id: holidays.id })
        .from(holidays)
        .where(and(
          eq(holidays.employeeId, mark.employeeId),
          or(eq(holidays.date, slashDate), eq(holidays.date, dashDate))
        ))
        .limit(1);
      if (existingAttendance.length > 0 || existingHoliday.length > 0) {
        return 'skipped_occupied';
      }

      const [holiday] = await tx
        .insert(holidays)
        .values({
          employeeId: mark.employeeId,
          date: dashDate,
          name: mark.name,
          holidayType: 'national_holiday',
          description: AUTO_NATIONAL_HOLIDAY_DESCRIPTION,
        })
        .returning();

      // 與 holidays.routes 的 ensureHolidayAttendanceRecord 同樣的紀錄形狀。
      await tx.insert(temporaryAttendance).values({
        employeeId: mark.employeeId,
        date: dashDate,
        clockIn: '--:--',
        clockOut: '--:--',
        isHoliday: true,
        isBarcodeScanned: false,
        holidayId: holiday.id,
        holidayType: 'national_holiday',
      });

      return 'created';
    });
  }
}

export const holidayAutomationRepository = new DatabaseHolidayAutomationRepository();
