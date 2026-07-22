import { eq, and, desc, or, isNull, isNotNull, inArray, lte, ilike, type SQL, sql as drizzleSql } from "drizzle-orm";
import { normalizeDateToDash, normalizeDateToSlash } from "../shared/utils/specialLeaveSync";
import { createLogger } from "./utils/logger";
import {
  maskEmployeeIdentityForLog,
} from "./utils/employeeIdentity";

import {
  temporaryAttendance, type TemporaryAttendance, type InsertTemporaryAttendance,
  settings, type Settings, type InsertSettings,
  holidays, type Holiday, type InsertHoliday,
  employees, type Employee, type InsertEmployee,
  pendingBindings, type PendingBinding, type InsertPendingBinding,
  oauthStates, type OAuthState, type InsertOAuthState,
  calculationRules, type CalculationRule, type InsertCalculationRule,
  taiwanHolidays, type TaiwanHoliday, type InsertTaiwanHoliday
} from "@shared/schema";

import { db } from './db';
import { DatabaseEmployeeRepository } from './repositories/employeeRepository';
import { compareAttendanceByLatestEvent } from './routes/scan-helpers';

const log = createLogger('storage');

export type AttendanceScanAction = 'clockIn' | 'clockOut';

export interface AttendanceScanUpsertInput {
  employeeId: number;
  dateKey: string;
  time: string;
  isHoliday: boolean;
  expectedAction: AttendanceScanAction;
}

export interface TemporaryAttendancePageFilters {
  employeeId?: number;
  date?: string;
  month?: string;
  search?: string;
}

export type AttendanceScanUpsertResult =
  | {
      duplicate: false;
      action: AttendanceScanAction;
      attendance: TemporaryAttendance;
    }
  | {
      duplicate: true;
      action: AttendanceScanAction;
      attendance?: TemporaryAttendance;
    };

function getLatestIncompleteAttendanceRecord(
  records: TemporaryAttendance[]
): TemporaryAttendance | undefined {
  return [...records]
    .filter(record => !record.clockOut || record.clockOut.trim() === '')
    .sort(compareAttendanceByLatestEvent)[0];
}

function toLikePattern(value: string): string {
  return `%${value.trim()}%`;
}

function buildTemporaryAttendancePageWhere(filters?: TemporaryAttendancePageFilters): SQL | undefined {
  if (!filters) {
    return undefined;
  }

  const conditions: SQL[] = [];

  if (filters.employeeId !== undefined) {
    conditions.push(eq(temporaryAttendance.employeeId, filters.employeeId));
  }

  if (filters.date) {
    const slashDate = normalizeDateToSlash(filters.date);
    const dashDate = normalizeDateToDash(filters.date);
    conditions.push(
      or(
        eq(temporaryAttendance.date, slashDate),
        eq(temporaryAttendance.date, dashDate)
      )!
    );
  }

  if (filters.month) {
    const normalizedMonth = filters.month.replace(/\//g, '-');
    const [yearValue, monthValue] = normalizedMonth.split('-');
    const year = Number.parseInt(yearValue ?? '', 10);
    const month = Number.parseInt(monthValue ?? '', 10);

    if (Number.isFinite(year) && Number.isFinite(month) && month >= 1 && month <= 12) {
      const paddedMonth = String(month).padStart(2, '0');
      const slashPrefix = `${year}/${paddedMonth}/%`;
      const dashPrefix = `${year}-${paddedMonth}-%`;
      conditions.push(
        drizzleSql`(${temporaryAttendance.date} like ${slashPrefix} or ${temporaryAttendance.date} like ${dashPrefix})`
      );
    }
  }

  if (filters.search?.trim()) {
    const pattern = toLikePattern(filters.search);
    conditions.push(
      or(
        ilike(temporaryAttendance.date, pattern),
        ilike(temporaryAttendance.clockIn, pattern),
        ilike(temporaryAttendance.clockOut, pattern)
      )!
    );
  }

  return conditions.length > 0 ? and(...conditions) : undefined;
}

export interface IStorage {
  // Employee methods - for barcode scanning
  getAllEmployees(): Promise<Employee[]>;
  getAllEmployeesIncludingDeleted(): Promise<Employee[]>;
  getDeletedEmployees(): Promise<Employee[]>;
  getEmployeeById(id: number): Promise<Employee | undefined>;
  getEmployeeByIdIncludingDeleted(id: number): Promise<Employee | undefined>;
  getEmployeeByIdNumber(idNumber: string): Promise<Employee | undefined>;
  createEmployee(employee: InsertEmployee): Promise<Employee>;
  updateEmployee(id: number, employee: Partial<InsertEmployee>): Promise<Employee | undefined>;
  deleteEmployee(id: number, deletedBy?: string): Promise<boolean>;
  restoreEmployee(id: number): Promise<Employee | undefined>;
  purgeEmployee(id: number): Promise<{ purged: boolean; anonymizedSalaryRecords: number }>;
  purgeExpiredDeletedEmployees(): Promise<{ purgedEmployeeIds: number[]; anonymizedSalaryRecords: number }>;

  // Temporary attendance methods
  getTemporaryAttendance(): Promise<TemporaryAttendance[]>;
  getTemporaryAttendancePage(page: number, limit: number, filters?: TemporaryAttendancePageFilters): Promise<{ rows: TemporaryAttendance[]; total: number }>;
  getTemporaryAttendanceById(id: number): Promise<TemporaryAttendance | undefined>;
  getTemporaryAttendanceByDate(date: string): Promise<TemporaryAttendance[]>; // 查詢特定日期的所有考勤記錄
  getTemporaryAttendanceByEmployeeAndDate(employeeId: number, date: string): Promise<TemporaryAttendance[]>; // 查詢特定員工特定日期的考勤記錄
  getTemporaryAttendanceByEmployeeAndMonth(employeeId: number, year: number, month: number): Promise<TemporaryAttendance[]>;
  getTemporaryAttendanceByMonth(year: number, month: number): Promise<TemporaryAttendance[]>;
  upsertTemporaryAttendanceScan(input: AttendanceScanUpsertInput): Promise<AttendanceScanUpsertResult>;
  createTemporaryAttendance(attendance: InsertTemporaryAttendance): Promise<TemporaryAttendance>;
  updateTemporaryAttendance(id: number, attendance: Partial<InsertTemporaryAttendance>): Promise<TemporaryAttendance | undefined>;
  deleteTemporaryAttendance(id: number): Promise<boolean>;
  deleteAllTemporaryAttendance(): Promise<boolean>;
  deleteTemporaryAttendanceByEmployeeId(employeeId: number): Promise<void>; // 刪除特定員工的所有考勤記錄

  // Settings methods
  getSettings(): Promise<Settings | undefined>;
  createOrUpdateSettings(newSettings: InsertSettings): Promise<Settings>;

  // Salary records and monthly salary runs live in
  // server/repositories/salaryRepository.ts and
  // server/repositories/monthlySalaryRunRepository.ts — import those directly.

  // Holiday methods
  getAllHolidays(): Promise<Holiday[]>;
  getHolidayById(id: number): Promise<Holiday | undefined>;
  createHoliday(holiday: InsertHoliday): Promise<Holiday>;
  deleteHoliday(id: number): Promise<boolean>;
  deleteAllHolidays(): Promise<boolean>;
  deleteTemporaryAttendanceByEmployeeAndDate(employeeId: number, date: string): Promise<boolean>;
  deleteTemporaryAttendanceByHolidayId(holidayId: number): Promise<boolean>;
  getAttendanceByHolidayId(holidayId: number): Promise<TemporaryAttendance | undefined>;

  // LINE binding methods
  getEmployeeByLineUserId(lineUserId: string): Promise<Employee | undefined>;
  getPendingBindings(): Promise<Array<PendingBinding & { employeeName: string }>>;
  getPendingBindingById(id: number): Promise<PendingBinding | undefined>;
  getPendingBindingByLineUserId(lineUserId: string): Promise<PendingBinding | undefined>;
  createPendingBinding(binding: InsertPendingBinding): Promise<PendingBinding>;
  approvePendingBinding(id: number, reviewedBy: string): Promise<PendingBinding | undefined>;
  rejectPendingBinding(id: number, reviewedBy: string, reason: string): Promise<PendingBinding | undefined>;
  deletePendingBinding(id: number): Promise<boolean>;

  // OAuth state methods
  createOAuthState(state: InsertOAuthState): Promise<OAuthState>;
  getOAuthState(stateValue: string): Promise<OAuthState | undefined>;
  deleteOAuthState(stateValue: string): Promise<boolean>;
  cleanupExpiredOAuthStates(): Promise<void>;

  // Encryption migration
  encryptAllPlaintextEmployees(): Promise<{ migrated: number; skipped: number }>;

  // Calculation rules methods
  getCalculationRules(): Promise<CalculationRule[]>;
  createCalculationRule(data: InsertCalculationRule): Promise<CalculationRule>;
  updateCalculationRule(id: number, data: Partial<InsertCalculationRule>): Promise<CalculationRule | undefined>;
  deleteCalculationRule(id: number): Promise<boolean>;

  // Taiwan holidays methods
  getTaiwanHolidays(year?: number): Promise<TaiwanHoliday[]>;
  importTaiwanHolidays(holidays: InsertTaiwanHoliday[]): Promise<{ imported: number; replaced: number }>;
  deleteTaiwanHoliday(id: string): Promise<boolean>;
}

export class DatabaseStorage implements IStorage {
  private readonly employeeRepository = new DatabaseEmployeeRepository();

  // Employee methods - for barcode scanning
  async getAllEmployees(): Promise<Employee[]> {
    return this.employeeRepository.getAllEmployees();
  }

  async getAllEmployeesIncludingDeleted(): Promise<Employee[]> {
    return this.employeeRepository.getAllEmployeesIncludingDeleted();
  }

  async getDeletedEmployees(): Promise<Employee[]> {
    return this.employeeRepository.getDeletedEmployees();
  }

  async getEmployeeById(id: number): Promise<Employee | undefined> {
    return this.employeeRepository.getEmployeeById(id);
  }

  async getEmployeeByIdIncludingDeleted(id: number): Promise<Employee | undefined> {
    return this.employeeRepository.getEmployeeByIdIncludingDeleted(id);
  }

  async getEmployeeByIdNumber(idNumber: string): Promise<Employee | undefined> {
    return this.employeeRepository.getEmployeeByIdNumber(idNumber);
  }

  async createEmployee(employee: InsertEmployee): Promise<Employee> {
    return this.employeeRepository.createEmployee(employee);
  }

  async updateEmployee(id: number, employee: Partial<InsertEmployee>): Promise<Employee | undefined> {
    return this.employeeRepository.updateEmployee(id, employee);
  }

  async deleteEmployee(id: number, deletedBy = 'admin'): Promise<boolean> {
    return this.employeeRepository.deleteEmployee(id, deletedBy);
  }

  async restoreEmployee(id: number): Promise<Employee | undefined> {
    return this.employeeRepository.restoreEmployee(id);
  }

  async purgeEmployee(id: number): Promise<{ purged: boolean; anonymizedSalaryRecords: number }> {
    return this.employeeRepository.purgeEmployee(id);
  }

  async purgeExpiredDeletedEmployees(): Promise<{ purgedEmployeeIds: number[]; anonymizedSalaryRecords: number }> {
    return this.employeeRepository.purgeExpiredDeletedEmployees();
  }

  // Temporary attendance methods
  async getTemporaryAttendance(): Promise<TemporaryAttendance[]> {
    return await db.select().from(temporaryAttendance);
  }

  async getTemporaryAttendancePage(page: number, limit: number, filters?: TemporaryAttendancePageFilters): Promise<{ rows: TemporaryAttendance[]; total: number }> {
    const offset = (page - 1) * limit;
    const whereClause = buildTemporaryAttendancePageWhere(filters);

    if (whereClause) {
      const [rows, [{ count }]] = await Promise.all([
        db
          .select()
          .from(temporaryAttendance)
          .where(whereClause)
          .orderBy(desc(temporaryAttendance.id))
          .limit(limit)
          .offset(offset),
        db
          .select({ count: drizzleSql<number>`count(*)::int` })
          .from(temporaryAttendance)
          .where(whereClause)
      ]);
      return { rows, total: count };
    }

    const [rows, [{ count }]] = await Promise.all([
      db.select().from(temporaryAttendance).orderBy(desc(temporaryAttendance.id)).limit(limit).offset(offset),
      db.select({ count: drizzleSql<number>`count(*)::int` }).from(temporaryAttendance)
    ]);
    return { rows, total: count };
  }

  async getTemporaryAttendanceById(id: number): Promise<TemporaryAttendance | undefined> {
    const [attendance] = await db.select().from(temporaryAttendance).where(eq(temporaryAttendance.id, id));
    return attendance;
  }

  async getTemporaryAttendanceByDate(date: string): Promise<TemporaryAttendance[]> {
    const slashDate = normalizeDateToSlash(date);
    const dashDate = normalizeDateToDash(date);

    return await db.select()
      .from(temporaryAttendance)
      .where(
        or(
          eq(temporaryAttendance.date, slashDate),
          eq(temporaryAttendance.date, dashDate)
        )
      );
  }

  async getTemporaryAttendanceByEmployeeAndDate(employeeId: number, date: string): Promise<TemporaryAttendance[]> {
    log.debug(`[數據查詢] 查詢員工ID: ${employeeId}, 日期: ${date} 的考勤記錄`);

    try {
      const slashDate = normalizeDateToSlash(date);
      const dashDate = normalizeDateToDash(date);

      // 使用精確匹配查詢
      const records = await db.select()
        .from(temporaryAttendance)
        .where(
          and(
            eq(temporaryAttendance.employeeId, employeeId),
            or(
              eq(temporaryAttendance.date, slashDate),
              eq(temporaryAttendance.date, dashDate)
            )
          )
        );

      log.debug(`[數據查詢] 找到 ${records.length} 筆考勤記錄`);
      if (records.length > 0) {
        log.debug(`[數據查詢] 第一筆記錄日期: ${records[0].date}`);
      }

      return records;
    } catch (error) {
      log.error(`[數據查詢錯誤] 查詢考勤記錄失敗:`, error);
      return []; // 返回空數組而不是拋出錯誤
    }
  }

  async getTemporaryAttendanceByEmployeeAndMonth(employeeId: number, year: number, month: number): Promise<TemporaryAttendance[]> {
    const normalizedMonth = String(month).padStart(2, '0');
    const slashPrefix = `${year}/${normalizedMonth}/%`;
    const dashPrefix = `${year}-${normalizedMonth}-%`;

    return db
      .select()
      .from(temporaryAttendance)
      .where(
        and(
          eq(temporaryAttendance.employeeId, employeeId),
          drizzleSql`(${temporaryAttendance.date} like ${slashPrefix} or ${temporaryAttendance.date} like ${dashPrefix})`
        )
      );
  }

  async getTemporaryAttendanceByMonth(year: number, month: number): Promise<TemporaryAttendance[]> {
    const normalizedMonth = String(month).padStart(2, '0');
    const slashPrefix = `${year}/${normalizedMonth}/%`;
    const dashPrefix = `${year}-${normalizedMonth}-%`;

    return db
      .select()
      .from(temporaryAttendance)
      .where(
        drizzleSql`(${temporaryAttendance.date} like ${slashPrefix} or ${temporaryAttendance.date} like ${dashPrefix})`
      );
  }

  async upsertTemporaryAttendanceScan(input: AttendanceScanUpsertInput): Promise<AttendanceScanUpsertResult> {
    const slashDate = normalizeDateToSlash(input.dateKey);
    const dashDate = normalizeDateToDash(input.dateKey);

    return db.transaction(async (tx) => {
      await tx.execute(drizzleSql`select pg_advisory_xact_lock(918273, ${input.employeeId})`);

      const existingRecords = await tx
        .select()
        .from(temporaryAttendance)
        .where(
          and(
            eq(temporaryAttendance.employeeId, input.employeeId),
            or(
              eq(temporaryAttendance.date, slashDate),
              eq(temporaryAttendance.date, dashDate)
            )
          )
        );

      const latestIncompleteRecord = getLatestIncompleteAttendanceRecord(existingRecords);
      const action: AttendanceScanAction = latestIncompleteRecord ? 'clockOut' : 'clockIn';

      if (action !== input.expectedAction) {
        return {
          duplicate: true,
          action,
          attendance: latestIncompleteRecord
        };
      }

      if (latestIncompleteRecord) {
        const [updatedAttendance] = await tx
          .update(temporaryAttendance)
          .set({ clockOut: input.time })
          .where(eq(temporaryAttendance.id, latestIncompleteRecord.id))
          .returning();

        if (!updatedAttendance) {
          throw new Error('Unable to persist scan attendance record');
        }

        return {
          duplicate: false,
          action,
          attendance: updatedAttendance
        };
      }

      const [newAttendance] = await tx
        .insert(temporaryAttendance)
        .values({
          employeeId: input.employeeId,
          date: input.dateKey,
          clockIn: input.time,
          clockOut: '',
          isHoliday: input.isHoliday,
          isBarcodeScanned: true
        })
        .returning();

      if (!newAttendance) {
        throw new Error('Unable to persist scan attendance record');
      }

      return {
        duplicate: false,
        action,
        attendance: newAttendance
      };
    });
  }

  async createTemporaryAttendance(attendance: InsertTemporaryAttendance): Promise<TemporaryAttendance> {
    const [newAttendance] = await db.insert(temporaryAttendance).values(attendance).returning();
    return newAttendance;
  }

  async updateTemporaryAttendance(id: number, attendance: Partial<InsertTemporaryAttendance>): Promise<TemporaryAttendance | undefined> {
    const [updatedAttendance] = await db
      .update(temporaryAttendance)
      .set(attendance)
      .where(eq(temporaryAttendance.id, id))
      .returning();
    return updatedAttendance;
  }

  async deleteTemporaryAttendance(id: number): Promise<boolean> {
    const [deleted] = await db
      .delete(temporaryAttendance)
      .where(eq(temporaryAttendance.id, id))
      .returning();
    return !!deleted;
  }

  async deleteAllTemporaryAttendance(): Promise<boolean> {
    await db.delete(temporaryAttendance);
    return true;
  }

  async deleteTemporaryAttendanceByEmployeeId(employeeId: number): Promise<void> {
    log.info(`刪除員工ID為 ${employeeId} 的所有考勤記錄`);

    await db
      .delete(temporaryAttendance)
      .where(eq(temporaryAttendance.employeeId, employeeId));

    log.info(`成功刪除員工ID為 ${employeeId} 的所有考勤記錄`);
  }

  // Settings methods
  async getSettings(): Promise<Settings | undefined> {
    const [setting] = await db.select().from(settings);
    return setting;
  }

  async createOrUpdateSettings(newSettings: InsertSettings): Promise<Settings> {
    const existingSettings = await this.getSettings();

    if (existingSettings) {
      const [updatedSettings] = await db
        .update(settings)
        .set({ ...newSettings, updatedAt: new Date() } as typeof settings.$inferInsert)
        .where(eq(settings.id, existingSettings.id))
        .returning();
      return updatedSettings;
    } else {
      const [createdSettings] = await db
        .insert(settings)
        .values(newSettings as typeof settings.$inferInsert)
        .returning();
      return createdSettings;
    }
  }

  // Holiday methods
  async getAllHolidays(): Promise<Holiday[]> {
    return await db.select().from(holidays);
  }

  async getHolidayById(id: number): Promise<Holiday | undefined> {
    const [holiday] = await db.select().from(holidays).where(eq(holidays.id, id));
    return holiday;
  }

  async createHoliday(holiday: InsertHoliday): Promise<Holiday> {
    const [newHoliday] = await db.insert(holidays).values(holiday).returning();
    return newHoliday;
  }

  async deleteHoliday(id: number): Promise<boolean> {
    const [deleted] = await db
      .delete(holidays)
      .where(eq(holidays.id, id))
      .returning();
    return !!deleted;
  }

  async deleteAllHolidays(): Promise<boolean> {
    try {
      await db.delete(holidays);
      return true;
    } catch (error) {
      log.error('Error deleting all holidays:', error);
      return false;
    }
  }

  async deleteTemporaryAttendanceByEmployeeAndDate(employeeId: number, date: string): Promise<boolean> {
    try {
      const slashDate = normalizeDateToSlash(date);
      const dashDate = normalizeDateToDash(date);

      await db
        .delete(temporaryAttendance)
        .where(
          and(
            eq(temporaryAttendance.employeeId, employeeId),
            or(
              eq(temporaryAttendance.date, slashDate),
              eq(temporaryAttendance.date, dashDate)
            )
          )
        );
      return true;
    } catch (error) {
      log.error('Error deleting attendance by employee and date:', error);
      return false;
    }
  }

  async deleteTemporaryAttendanceByHolidayId(holidayId: number): Promise<boolean> {
    try {
      await db
        .delete(temporaryAttendance)
        .where(eq(temporaryAttendance.holidayId, holidayId));
      return true;
    } catch (error) {
      log.error('Error deleting attendance by holiday ID:', error);
      return false;
    }
  }

  async getAttendanceByHolidayId(holidayId: number): Promise<TemporaryAttendance | undefined> {
    const [record] = await db
      .select()
      .from(temporaryAttendance)
      .where(eq(temporaryAttendance.holidayId, holidayId));
    return record;
  }

  // ── LINE binding methods ──────────────────────────────────────────────────

  async getEmployeeByLineUserId(lineUserId: string): Promise<Employee | undefined> {
    const [employee] = await db
      .select()
      .from(employees)
      .where(and(eq(employees.lineUserId, lineUserId), isNull(employees.deletedAt)));
    return employee;
  }

  async getPendingBindings(): Promise<Array<PendingBinding & { employeeName: string }>> {
    const rows = await db
      .select({ binding: pendingBindings, employeeName: employees.name })
      .from(pendingBindings)
      .innerJoin(
        employees,
        and(eq(pendingBindings.employeeId, employees.id), isNull(employees.deletedAt))
      )
      .where(eq(pendingBindings.status, 'pending'))
      .orderBy(desc(pendingBindings.requestedAt));
    return rows.map(({ binding, employeeName }) => ({ ...binding, employeeName }));
  }

  async getPendingBindingById(id: number): Promise<PendingBinding | undefined> {
    const [binding] = await db
      .select()
      .from(pendingBindings)
      .where(eq(pendingBindings.id, id));
    return binding;
  }

  async getPendingBindingByLineUserId(lineUserId: string): Promise<PendingBinding | undefined> {
    const [binding] = await db
      .select()
      .from(pendingBindings)
      .where(
        and(
          eq(pendingBindings.lineUserId, lineUserId),
          eq(pendingBindings.status, 'pending')
        )
      )
      .orderBy(desc(pendingBindings.requestedAt));
    return binding;
  }

  async createPendingBinding(binding: InsertPendingBinding): Promise<PendingBinding> {
    const [created] = await db
      .insert(pendingBindings)
      .values(binding)
      .returning();
    return created;
  }

  async approvePendingBinding(id: number, reviewedBy: string): Promise<PendingBinding | undefined> {
    return db.transaction(async (tx) => {
      const [binding] = await tx
        .select()
        .from(pendingBindings)
        .where(and(eq(pendingBindings.id, id), eq(pendingBindings.status, 'pending')));
      if (!binding) return undefined;

      const [employee] = await tx
        .select()
        .from(employees)
        .where(and(eq(employees.id, binding.employeeId), isNull(employees.deletedAt)));
      if (!employee) return undefined;

      await tx
        .update(employees)
        .set({
          lineUserId: binding.lineUserId,
          lineDisplayName: binding.lineDisplayName,
          linePictureUrl: binding.linePictureUrl,
          lineBindingDate: new Date()
        })
        .where(eq(employees.id, binding.employeeId));

      const [updated] = await tx
        .update(pendingBindings)
        .set({ status: 'approved', reviewedAt: new Date(), reviewedBy })
        .where(eq(pendingBindings.id, id))
        .returning();
      return updated;
    });
  }

  async rejectPendingBinding(id: number, reviewedBy: string, reason: string): Promise<PendingBinding | undefined> {
    const [updated] = await db
      .update(pendingBindings)
      .set({ status: 'rejected', reviewedAt: new Date(), reviewedBy, rejectReason: reason })
      .where(eq(pendingBindings.id, id))
      .returning();
    return updated;
  }

  async deletePendingBinding(id: number): Promise<boolean> {
    const [deleted] = await db
      .delete(pendingBindings)
      .where(eq(pendingBindings.id, id))
      .returning();
    return !!deleted;
  }

  // ── OAuth state methods ──────────────────────────────────────────────────

  async createOAuthState(state: InsertOAuthState): Promise<OAuthState> {
    const [created] = await db
      .insert(oauthStates)
      .values(state)
      .returning();
    return created;
  }

  async getOAuthState(stateValue: string): Promise<OAuthState | undefined> {
    const [record] = await db
      .select()
      .from(oauthStates)
      .where(eq(oauthStates.state, stateValue));
    return record;
  }

  async deleteOAuthState(stateValue: string): Promise<boolean> {
    const [deleted] = await db
      .delete(oauthStates)
      .where(eq(oauthStates.state, stateValue))
      .returning();
    return !!deleted;
  }

  async cleanupExpiredOAuthStates(): Promise<void> {
    await db
      .delete(oauthStates)
      .where(drizzleSql`${oauthStates.expiresAt} < now()`);
  }

  async encryptAllPlaintextEmployees(): Promise<{ migrated: number; skipped: number }> {
    return this.employeeRepository.encryptAllPlaintextEmployees();
  }

  async getCalculationRules(): Promise<CalculationRule[]> {
    return db.select().from(calculationRules).orderBy(calculationRules.year, calculationRules.month);
  }

  async createCalculationRule(data: InsertCalculationRule): Promise<CalculationRule> {
    const [created] = await db
      .insert(calculationRules)
      .values(data)
      .returning();
    return created;
  }

  async updateCalculationRule(id: number, data: Partial<InsertCalculationRule>): Promise<CalculationRule | undefined> {
    const [updated] = await db
      .update(calculationRules)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(calculationRules.id, id))
      .returning();
    return updated;
  }

  async deleteCalculationRule(id: number): Promise<boolean> {
    const [deleted] = await db
      .delete(calculationRules)
      .where(eq(calculationRules.id, id))
      .returning();
    return !!deleted;
  }

  // ── Taiwan holidays methods ───────────────────────────────────────────────

  async getTaiwanHolidays(year?: number): Promise<TaiwanHoliday[]> {
    if (year !== undefined) {
      return db
        .select()
        .from(taiwanHolidays)
        .where(eq(taiwanHolidays.year, year))
        .orderBy(taiwanHolidays.holidayDate);
    }
    return db.select().from(taiwanHolidays).orderBy(taiwanHolidays.year, taiwanHolidays.holidayDate);
  }

  async importTaiwanHolidays(holidays: InsertTaiwanHoliday[]): Promise<{ imported: number; replaced: number }> {
    if (holidays.length === 0) {
      return { imported: 0, replaced: 0 };
    }

    // Group by year to determine which years are being replaced
    const years = Array.from(new Set(holidays.map((h) => h.year)));

    return db.transaction(async (tx) => {
      let replaced = 0;
      for (const year of years) {
        const existing = await tx
          .delete(taiwanHolidays)
          .where(eq(taiwanHolidays.year, year))
          .returning({ id: taiwanHolidays.id });
        replaced += existing.length;
      }

      const inserted = await tx
        .insert(taiwanHolidays)
        .values(holidays)
        .returning({ id: taiwanHolidays.id });

      return { imported: inserted.length, replaced };
    });
  }

  async deleteTaiwanHoliday(id: string): Promise<boolean> {
    const [deleted] = await db
      .delete(taiwanHolidays)
      .where(eq(taiwanHolidays.id, id))
      .returning();
    return !!deleted;
  }
}

// Production strategy: PostgreSQL is the single supported runtime storage.
// Supabase storage has been deprecated and removed from the active code path.

export const storage: IStorage = new DatabaseStorage();
