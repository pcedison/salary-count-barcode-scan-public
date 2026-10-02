import { assertPayrollWritesEnabled } from '../config/payrollWrites';
import { and, desc, eq, ilike, inArray, isNotNull, lte, or, sql as drizzleSql, type SQL } from 'drizzle-orm';

import {
  salaryRecords, salaryCorrections, type SalaryCorrection,
  type InsertSalaryRecord,
  type SalaryRecord,
} from '@shared/schema';

import { db } from '../db';
import type { PayrollCorrectionPreview } from '@shared/payrollCorrection';

export interface SalaryCorrectionCommit {
  idempotencyKey: string;
  requestHash: string;
  previewTokenHash: string;
  actorId: string;
  actorRole: string;
}

function payrollAuditSnapshot(record: SalaryRecord): SalaryRecord {
  return {
    ...record, employeeId: null, employeeName: null, employeeSnapshot: null,
    attendanceData: record.attendanceData?.map(row => ({
      id: row.id, employeeId: null, date: row.date, clockIn: row.clockIn, clockOut: row.clockOut,
      isHoliday: row.isHoliday, isBarcodeScanned: row.isBarcodeScanned,
      holidayId: row.holidayId, holidayType: row.holidayType, createdAt: row.createdAt,
      ...(row.overtimeHours !== undefined ? { overtimeHours: row.overtimeHours } : {}),
    })) ?? null,
    specialLeaveInfo: record.specialLeaveInfo ? {
      usedDays: record.specialLeaveInfo.usedDays, usedDates: record.specialLeaveInfo.usedDates,
      cashDays: record.specialLeaveInfo.cashDays, cashAmount: record.specialLeaveInfo.cashAmount,
      cashMonth: record.specialLeaveInfo.cashMonth,
    } : null,
  };
}



export interface SalaryRecordPageFilters {
  employeeId?: number;
  salaryYear?: number;
  salaryMonth?: number;
  search?: string;
}

export type SalaryRecordYearFilters = Omit<SalaryRecordPageFilters, 'salaryYear'>;

/** Trusted snapshot writers preserve a provided basis, including unknown legacy null.
 * New settlements must use buildCalculatedSalaryRecord; do not infer historical
 * calculation evidence from a CSV record's editable displayed base salary.
 */
export type SalaryRecordSnapshotInput = InsertSalaryRecord & {
  holidayCalculationBaseSalary?: number | null;
};

/** 單筆薪資寫入意圖:有 existingId 走 update,否則 insert。供原子批次寫入使用。 */
export interface SalaryRecordWrite {
  existingId?: number;
  expectedRevision?: number;
  record: SalaryRecordSnapshotInput;
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
  async getFinalizedSalaryMonths() {
    return db.select({ id: salaryRecords.id, employeeId: salaryRecords.employeeId, salaryYear: salaryRecords.salaryYear, salaryMonth: salaryRecords.salaryMonth }).from(salaryRecords);
  }

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

  async getSalaryCorrections(id: number): Promise<SalaryCorrection[]> {
    return db.select().from(salaryCorrections).where(eq(salaryCorrections.originalRecordId, id)).orderBy(desc(salaryCorrections.revision)).limit(100);
  }

  async commitSalaryCorrection(id: number, commit: SalaryCorrectionCommit, build: (record: SalaryRecord) => PayrollCorrectionPreview) {
    assertPayrollWritesEnabled();
    return db.transaction(async tx => {
      const [current] = await tx.select().from(salaryRecords).where(eq(salaryRecords.id, id)).for('update');
      if (!current) throw Object.assign(new Error('Salary record not found.'), { status: 404, code: 'NOT_FOUND' });
      const [prior] = await tx.select().from(salaryCorrections).where(and(eq(salaryCorrections.originalRecordId, id), eq(salaryCorrections.idempotencyKey, commit.idempotencyKey)));
      if (prior) {
        if (prior.requestHash !== commit.requestHash || prior.previewTokenHash !== commit.previewTokenHash || prior.actorId !== commit.actorId) {
          throw Object.assign(new Error('This idempotency key belongs to a different correction.'), { status: 409, code: 'IDEMPOTENCY_CONFLICT' });
        }
        return { record: current, correction: prior, replayed: true };
      }
      const preview = build(current);
      const revision = current.revision + 1;
      const { id: _id, revision: _revision, createdAt: _createdAt, ...updated } = preview.after;
      const [record] = await tx.update(salaryRecords).set({ ...updated, revision }).where(and(eq(salaryRecords.id, id), eq(salaryRecords.revision, current.revision))).returning();
      if (!record) throw Object.assign(new Error('Salary record changed; reload and preview again.'), { status: 409, code: 'REVISION_CONFLICT' });
      const [correction] = await tx.insert(salaryCorrections).values({
        ...commit, salaryRecordId: id, originalRecordId: id, revision,
        reason: preview.reason, paymentHandling: preview.paymentHandling,
        holidays: preview.holidays, delta: preview.delta,
        beforeSnapshot: payrollAuditSnapshot(current), afterSnapshot: payrollAuditSnapshot(record),
      }).returning();
      return { record, correction, replayed: false };
    });
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

  async createSalaryRecord(record: SalaryRecordSnapshotInput): Promise<SalaryRecord> {
    assertPayrollWritesEnabled();
    // Strip any incoming id to avoid primary-key conflicts.
    const { id, ...recordWithoutId } = record as any;
    const [newRecord] = await db.insert(salaryRecords).values(recordWithoutId).returning();
    return newRecord;
  }

  async updateSalaryRecord(id: number, record: Partial<InsertSalaryRecord>): Promise<SalaryRecord | undefined> {
    assertPayrollWritesEnabled();
    return db.transaction(async tx => {
      const [current] = await tx.select({ id: salaryRecords.id }).from(salaryRecords).where(eq(salaryRecords.id, id)).for('update');
      if (!current) return undefined;
      const [correction] = await tx.select({ id: salaryCorrections.id }).from(salaryCorrections).where(eq(salaryCorrections.originalRecordId, id)).limit(1);
      if (correction) throw Object.assign(new Error('Corrected salary records require the audited correction workflow.'), { status: 409, code: 'CORRECTION_REQUIRED' });
      const update = record as Partial<typeof salaryRecords.$inferInsert>;
      const [updatedRecord] = await tx.update(salaryRecords).set({ ...update, revision: drizzleSql`${salaryRecords.revision} + 1` }).where(eq(salaryRecords.id, id)).returning();
      return updatedRecord;
    });
  }

  async saveSalaryRecordsAtomically(items: SalaryRecordWrite[]): Promise<SalaryRecord[]> {
    assertPayrollWritesEnabled();
    if (items.length === 0) {
      return [];
    }

    // 整批寫入包在單一 transaction:任何一筆失敗即全部回滾,
    // 不會留下半套月薪資料(run 狀態由呼叫端另行標記 failed)。
    return db.transaction(async (tx) => {
      const results: SalaryRecord[] = [];

      for (const item of items) {
        if (item.existingId != null) {
          const [current] = await tx.select().from(salaryRecords)
            .where(eq(salaryRecords.id, item.existingId)).for('update');
          if (!current) {
            throw new Error(`Salary record ${item.existingId} disappeared during atomic batch write`);
          }
          const [correction] = await tx.select({ id: salaryCorrections.id }).from(salaryCorrections)
            .where(eq(salaryCorrections.originalRecordId, item.existingId)).limit(1);
          if (correction) {
            throw Object.assign(new Error('Corrected salary records require the audited correction workflow.'), {
              status: 409, code: 'CORRECTION_REQUIRED',
            });
          }
          if (!Number.isInteger(item.expectedRevision) || item.expectedRevision !== current.revision) {
            throw Object.assign(new Error('Salary record changed after calculation; reload before rerunning.'), {
              status: 409, code: 'REVISION_CONFLICT',
            });
          }
          const [updated] = await tx
            .update(salaryRecords)
            .set({ ...item.record, revision: current.revision + 1 } as typeof salaryRecords.$inferInsert)
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
    assertPayrollWritesEnabled();
    return db.transaction(async tx => {
      const [current] = await tx.select({ id: salaryRecords.id }).from(salaryRecords).where(eq(salaryRecords.id, id)).for('update');
      if (!current) return false;
      const [correction] = await tx.select({ id: salaryCorrections.id }).from(salaryCorrections).where(eq(salaryCorrections.originalRecordId, id)).limit(1);
      if (correction) throw Object.assign(new Error('A salary record with corrections cannot be deleted through the history editor.'), { status: 409, code: 'CORRECTION_HISTORY_PROTECTED' });
      await tx.delete(salaryRecords).where(eq(salaryRecords.id, id));
      return true;
    });
  }

  async purgeExpiredRetainedSalaryRecords(): Promise<number> {
    assertPayrollWritesEnabled();
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
