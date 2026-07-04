import { and, desc, eq, ilike, inArray, isNotNull, lte, or, sql as drizzleSql, type SQL } from 'drizzle-orm';

import {
  salaryRecords,
  type InsertSalaryRecord,
  type SalaryRecord,
} from '@shared/schema';

import { db } from '../db';

export interface SalaryRecordPageFilters {
  employeeId?: number;
  salaryYear?: number;
  salaryMonth?: number;
  search?: string;
}

export type SalaryRecordYearFilters = Omit<SalaryRecordPageFilters, 'salaryYear'>;

/** 單筆薪資寫入意圖:有 existingId 走 update,否則 insert。供原子批次寫入使用。 */
export interface SalaryRecordWrite {
  existingId?: number;
  record: InsertSalaryRecord;
}

function toLikePattern(value: string): string {
  return `%${value.trim()}%`;
}

function buildSalaryRecordPageWhere(filters?: SalaryRecordPageFilters): SQL | undefined {
  if (!filters) {
    return undefined;
  }

  const conditions: SQL[] = [];

  if (filters.employeeId !== undefined) {
    conditions.push(eq(salaryRecords.employeeId, filters.employeeId));
  }

  if (filters.salaryYear !== undefined) {
    conditions.push(eq(salaryRecords.salaryYear, filters.salaryYear));
  }

  if (filters.salaryMonth !== undefined) {
    conditions.push(eq(salaryRecords.salaryMonth, filters.salaryMonth));
  }

  if (filters.search?.trim()) {
    const pattern = toLikePattern(filters.search);
    conditions.push(
      or(
        ilike(salaryRecords.employeeName, pattern),
        drizzleSql`${salaryRecords.salaryYear}::text like ${pattern}`,
        drizzleSql`${salaryRecords.salaryMonth}::text like ${pattern}`
      )!
    );
  }

  return conditions.length > 0 ? and(...conditions) : undefined;
}

export class DatabaseSalaryRepository {
  async getAllSalaryRecords(): Promise<SalaryRecord[]> {
    return await db
      .select()
      .from(salaryRecords)
      .orderBy(desc(salaryRecords.salaryYear), desc(salaryRecords.salaryMonth));
  }

  async getAllSalaryRecordsPage(page: number, limit: number, filters?: SalaryRecordPageFilters): Promise<{ rows: SalaryRecord[]; total: number }> {
    const offset = (page - 1) * limit;
    const whereClause = buildSalaryRecordPageWhere(filters);

    if (whereClause) {
      const [rows, [{ count }]] = await Promise.all([
        db.select().from(salaryRecords)
          .where(whereClause)
          .orderBy(desc(salaryRecords.salaryYear), desc(salaryRecords.salaryMonth), desc(salaryRecords.id))
          .limit(limit).offset(offset),
        db.select({ count: drizzleSql<number>`count(*)::int` }).from(salaryRecords).where(whereClause)
      ]);
      return { rows, total: count };
    }

    const [rows, [{ count }]] = await Promise.all([
      db.select().from(salaryRecords)
        .orderBy(desc(salaryRecords.salaryYear), desc(salaryRecords.salaryMonth), desc(salaryRecords.id))
        .limit(limit).offset(offset),
      db.select({ count: drizzleSql<number>`count(*)::int` }).from(salaryRecords)
    ]);
    return { rows, total: count };
  }

  async getSalaryRecordYears(filters?: SalaryRecordYearFilters): Promise<number[]> {
    const whereClause = buildSalaryRecordPageWhere(filters);
    const rows = whereClause
      ? await db
          .selectDistinct({ salaryYear: salaryRecords.salaryYear })
          .from(salaryRecords)
          .where(whereClause)
          .orderBy(desc(salaryRecords.salaryYear))
      : await db
          .selectDistinct({ salaryYear: salaryRecords.salaryYear })
          .from(salaryRecords)
          .orderBy(desc(salaryRecords.salaryYear));

    return rows.map((row) => row.salaryYear);
  }

  async getSalaryRecordById(id: number): Promise<SalaryRecord | undefined> {
    const [record] = await db.select().from(salaryRecords).where(eq(salaryRecords.id, id));
    return record;
  }

  async getSalaryRecordsByIds(ids: number[]): Promise<SalaryRecord[]> {
    if (ids.length === 0) {
      return [];
    }
    return db.select().from(salaryRecords).where(inArray(salaryRecords.id, ids));
  }

  async getSalaryRecordByYearMonth(year: number, month: number): Promise<SalaryRecord | undefined> {
    const [record] = await db
      .select()
      .from(salaryRecords)
      .where(
        and(
          eq(salaryRecords.salaryYear, year),
          eq(salaryRecords.salaryMonth, month)
        )
      );
    return record;
  }

  async getSalaryRecordsByYearMonth(year: number, month: number): Promise<SalaryRecord[]> {
    return db
      .select()
      .from(salaryRecords)
      .where(
        and(
          eq(salaryRecords.salaryYear, year),
          eq(salaryRecords.salaryMonth, month)
        )
      )
      .orderBy(desc(salaryRecords.id));
  }

  async getSalaryRecordByYearMonthEmployee(year: number, month: number, employeeId: number): Promise<SalaryRecord | undefined> {
    const [record] = await db
      .select()
      .from(salaryRecords)
      .where(
        and(
          eq(salaryRecords.salaryYear, year),
          eq(salaryRecords.salaryMonth, month),
          eq(salaryRecords.employeeId, employeeId)
        )
      );
    return record;
  }

  async createSalaryRecord(record: InsertSalaryRecord): Promise<SalaryRecord> {
    // Strip any incoming id to avoid primary-key conflicts.
    const { id, ...recordWithoutId } = record as any;
    const [newRecord] = await db.insert(salaryRecords).values(recordWithoutId).returning();
    return newRecord;
  }

  async updateSalaryRecord(id: number, record: Partial<InsertSalaryRecord>): Promise<SalaryRecord | undefined> {
    const [updatedRecord] = await db
      .update(salaryRecords)
      .set(record as typeof salaryRecords.$inferInsert)
      .where(eq(salaryRecords.id, id))
      .returning();
    return updatedRecord;
  }

  async saveSalaryRecordsAtomically(items: SalaryRecordWrite[]): Promise<SalaryRecord[]> {
    if (items.length === 0) {
      return [];
    }

    // 整批寫入包在單一 transaction:任何一筆失敗即全部回滾,
    // 不會留下半套月薪資料(run 狀態由呼叫端另行標記 failed)。
    return db.transaction(async (tx) => {
      const results: SalaryRecord[] = [];

      for (const item of items) {
        if (item.existingId != null) {
          const [updated] = await tx
            .update(salaryRecords)
            .set(item.record as typeof salaryRecords.$inferInsert)
            .where(eq(salaryRecords.id, item.existingId))
            .returning();
          if (!updated) {
            throw new Error(`Salary record ${item.existingId} disappeared during atomic batch write`);
          }
          results.push(updated);
        } else {
          const { id, ...recordWithoutId } = item.record as any;
          const [created] = await tx.insert(salaryRecords).values(recordWithoutId).returning();
          results.push(created);
        }
      }

      return results;
    });
  }

  async deleteSalaryRecord(id: number): Promise<boolean> {
    const [deleted] = await db
      .delete(salaryRecords)
      .where(eq(salaryRecords.id, id))
      .returning();
    return !!deleted;
  }

  async purgeExpiredRetainedSalaryRecords(): Promise<number> {
    const now = new Date();
    const deleted = await db
      .delete(salaryRecords)
      .where(
        and(
          isNotNull(salaryRecords.anonymizedAt),
          isNotNull(salaryRecords.retentionUntil),
          lte(salaryRecords.retentionUntil, now)
        )
      )
      .returning({ id: salaryRecords.id });

    return deleted.length;
  }
}

export const salaryRepository = new DatabaseSalaryRepository();
