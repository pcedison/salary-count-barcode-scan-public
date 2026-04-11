import { and, desc, eq, inArray, isNotNull, isNull, lte } from 'drizzle-orm';

import {
  employees,
  pendingBindings,
  salaryRecords,
  temporaryAttendance,
  holidays,
  type Employee,
  type InsertEmployee,
  type SalaryRecord
} from '@shared/schema';
import { isAESEncrypted } from '@shared/utils/encryption';

import { db } from '../db';
import {
  EMPLOYEE_RECYCLE_RETENTION_DAYS,
  SALARY_RETENTION_POLICY,
  SALARY_RETENTION_YEARS
} from '../config/retentionPolicy';
import {
  buildEmployeeIdentityLookupCandidates,
  encryptEmployeeIdentityForStorage,
  getEmployeeDisplayId,
  maskEmployeeIdentityForLog,
  normalizeEmployeeIdentity,
  prepareUpdatedEmployeeIdentityForStorage
} from '../utils/employeeIdentity';
import { createLogger } from '../utils/logger';

const log = createLogger('employee-repository');
const ANONYMIZED_EMPLOYEE_NAME = '[ANONYMIZED EMPLOYEE - RETAIN 5 YEARS]';

type SalaryRecordMutationExecutor = Pick<typeof db, 'select' | 'update'>;

function addDays(base: Date, days: number): Date {
  const next = new Date(base);
  next.setDate(next.getDate() + days);
  return next;
}

function addYears(base: Date, years: number): Date {
  const next = new Date(base);
  next.setFullYear(next.getFullYear() + years);
  return next;
}

function anonymizeAttendanceSnapshot(
  attendanceData: SalaryRecord['attendanceData']
): SalaryRecord['attendanceData'] {
  if (!Array.isArray(attendanceData)) {
    return attendanceData ?? null;
  }

  return attendanceData.map((entry) => ({
    ...entry,
    employeeId: null
  }));
}

function buildDeletedEmployeeSnapshot(
  employee: Employee,
  deletedAt: Date,
  deletedBy: string | null
): NonNullable<SalaryRecord['employeeSnapshot']> {
  return {
    employeeType: employee.employeeType ?? null,
    department: employee.department ?? null,
    position: employee.position ?? null,
    deletedAt: deletedAt.toISOString(),
    deletedBy,
    retentionYears: SALARY_RETENTION_YEARS,
    retentionPolicy: SALARY_RETENTION_POLICY
  };
}

export class DatabaseEmployeeRepository {
  private identityLookupCache: Map<string, Employee> | null = null;

  private invalidateIdentityLookupCache(): void {
    this.identityLookupCache = null;
  }

  private buildIdentityLookupKeys(employee: Employee): string[] {
    const lookupKeys = new Set<string>();

    for (const candidate of buildEmployeeIdentityLookupCandidates(employee.idNumber)) {
      lookupKeys.add(normalizeEmployeeIdentity(candidate));
    }

    const displayId = getEmployeeDisplayId(employee);
    if (displayId) {
      lookupKeys.add(normalizeEmployeeIdentity(displayId));
    }

    return Array.from(lookupKeys).filter(Boolean);
  }

  private async getIdentityLookupCache(): Promise<Map<string, Employee>> {
    if (this.identityLookupCache) {
      return this.identityLookupCache;
    }

    const cache = new Map<string, Employee>();
    const employees = await this.getAllEmployees();

    for (const employee of employees) {
      for (const lookupKey of this.buildIdentityLookupKeys(employee)) {
        if (!cache.has(lookupKey)) {
          cache.set(lookupKey, employee);
        }
      }
    }

    this.identityLookupCache = cache;
    return cache;
  }

  async getAllEmployees(): Promise<Employee[]> {
    return db
      .select()
      .from(employees)
      .where(isNull(employees.deletedAt))
      .orderBy(employees.name);
  }

  async getAllEmployeesIncludingDeleted(): Promise<Employee[]> {
    return db.select().from(employees).orderBy(employees.name);
  }

  async getDeletedEmployees(): Promise<Employee[]> {
    return db
      .select()
      .from(employees)
      .where(isNotNull(employees.deletedAt))
      .orderBy(desc(employees.deletedAt), employees.name);
  }

  async getEmployeeById(id: number): Promise<Employee | undefined> {
    const [employee] = await db
      .select()
      .from(employees)
      .where(and(eq(employees.id, id), isNull(employees.deletedAt)));
    return employee;
  }

  async getEmployeeByIdIncludingDeleted(id: number): Promise<Employee | undefined> {
    const [employee] = await db.select().from(employees).where(eq(employees.id, id));
    return employee;
  }

  async getEmployeeByIdNumber(idNumber: string): Promise<Employee | undefined> {
    const lookupCandidates = buildEmployeeIdentityLookupCandidates(idNumber);

    if (lookupCandidates.length === 0) {
      return undefined;
    }

    // Single IN query for all candidate ciphertexts instead of N sequential queries
    const matches = await db
      .select()
      .from(employees)
      .where(and(inArray(employees.idNumber, lookupCandidates), isNull(employees.deletedAt)));

    if (matches.length > 0) {
      return matches[0];
    }

    // Fallback: full-table scan + in-memory decryption match.
    // Needed when the stored ciphertext differs from every candidate
    // (e.g. different AES nonce used at write time — each AES-GCM encryption
    // produces a unique ciphertext even for the same plaintext).
    // NOTE: full-table fallback needed for AES-encrypted IDs — consider adding index on employees.id_number
    const lookupCache = await this.getIdentityLookupCache();
    for (const candidate of lookupCandidates.map(normalizeEmployeeIdentity)) {
      const cachedEmployee = lookupCache.get(candidate);
      if (cachedEmployee) {
        return cachedEmployee;
      }
    }

    return undefined;
  }

  async createEmployee(employee: InsertEmployee): Promise<Employee> {
    const processedEmployee = { ...employee };

    processedEmployee.idNumber = encryptEmployeeIdentityForStorage(
      processedEmployee.idNumber,
      processedEmployee.isEncrypted === true
    );

    const { useEncryption: _, ...employeeForDb } = processedEmployee as typeof processedEmployee & {
      useEncryption?: unknown;
    };

    const [newEmployee] = await db
      .insert(employees)
      .values(employeeForDb as typeof employees.$inferInsert)
      .returning();
    this.invalidateIdentityLookupCache();
    return newEmployee;
  }

  async updateEmployee(id: number, employee: Partial<InsertEmployee>): Promise<Employee | undefined> {
    if (process.env.NODE_ENV !== 'production') {
      log.debug(`更新員工 ID ${id}, 接收到的數據:`, JSON.stringify(employee));
    }

    const originalEmployee = await this.getEmployeeById(id);
    if (!originalEmployee) {
      log.error(`找不到要更新的員工 ID ${id}`);
      return undefined;
    }

    const processedEmployee = { ...employee };

    const wantsEncryption =
      processedEmployee.isEncrypted !== undefined
        ? processedEmployee.isEncrypted === true
        : originalEmployee.isEncrypted === true;

    if (processedEmployee.idNumber !== undefined || processedEmployee.isEncrypted !== undefined) {
      processedEmployee.idNumber = prepareUpdatedEmployeeIdentityForStorage({
        currentEmployee: originalEmployee,
        nextIdNumber: processedEmployee.idNumber,
        shouldEncrypt: wantsEncryption
      });
    }

    if (process.env.NODE_ENV !== 'production' && processedEmployee.idNumber !== undefined) {
      log.debug(
        `ID處理: ${maskEmployeeIdentityForLog(originalEmployee.idNumber)} -> ${maskEmployeeIdentityForLog(
          processedEmployee.idNumber
        )} (加密=${wantsEncryption})`
      );
    }

    const { useEncryption: _, ...employeeForDb } = processedEmployee as typeof processedEmployee & {
      useEncryption?: unknown;
    };

    const [updatedEmployee] = await db
      .update(employees)
      .set(employeeForDb as typeof employees.$inferInsert)
      .where(eq(employees.id, id))
      .returning();
    if (updatedEmployee) {
      this.invalidateIdentityLookupCache();
    }
    return updatedEmployee;
  }

  async deleteEmployee(id: number, deletedBy = 'admin'): Promise<boolean> {
    const trashed = await this.trashEmployee(id, deletedBy);
    if (trashed) {
      this.invalidateIdentityLookupCache();
    }
    return !!trashed;
  }

  async restoreEmployee(id: number): Promise<Employee | undefined> {
    const [restoredEmployee] = await db
      .update(employees)
      .set({
        deletedAt: null,
        deletedBy: null,
        purgeAfterAt: null
      })
      .where(and(eq(employees.id, id), isNotNull(employees.deletedAt)))
      .returning();
    if (restoredEmployee) {
      this.invalidateIdentityLookupCache();
    }
    return restoredEmployee;
  }

  async purgeEmployee(id: number): Promise<{ purged: boolean; anonymizedSalaryRecords: number }> {
    const result = await db.transaction(async (tx) => {
      const [employee] = await tx
        .select()
        .from(employees)
        .where(and(eq(employees.id, id), isNotNull(employees.deletedAt)));

      if (!employee) {
        return { purged: false, anonymizedSalaryRecords: 0 };
      }

      const deletedAt = employee.deletedAt ?? new Date();
      const anonymizedSalaryRecords = await this.anonymizeRetainedSalaryRecordsForEmployee(
        tx,
        employee,
        deletedAt,
        employee.deletedBy ?? null
      );

      await tx.delete(pendingBindings).where(eq(pendingBindings.employeeId, id));
      await tx.delete(temporaryAttendance).where(eq(temporaryAttendance.employeeId, id));
      await tx.delete(holidays).where(eq(holidays.employeeId, id));

      const [deletedEmployee] = await tx
        .delete(employees)
        .where(eq(employees.id, id))
        .returning();

      return {
        purged: !!deletedEmployee,
        anonymizedSalaryRecords
      };
    });

    if (result.purged) {
      this.invalidateIdentityLookupCache();
    }

    return result;
  }

  async purgeExpiredDeletedEmployees(): Promise<{
    purgedEmployeeIds: number[];
    anonymizedSalaryRecords: number;
  }> {
    const now = new Date();
    const expiredEmployees = await db
      .select({ id: employees.id })
      .from(employees)
      .where(
        and(
          isNotNull(employees.deletedAt),
          isNotNull(employees.purgeAfterAt),
          lte(employees.purgeAfterAt, now)
        )
      );

    const purgedEmployeeIds: number[] = [];
    let anonymizedSalaryRecords = 0;

    for (const employee of expiredEmployees) {
      const result = await this.purgeEmployee(employee.id);
      if (result.purged) {
        purgedEmployeeIds.push(employee.id);
        anonymizedSalaryRecords += result.anonymizedSalaryRecords;
      }
    }

    return { purgedEmployeeIds, anonymizedSalaryRecords };
  }

  async encryptAllPlaintextEmployees(): Promise<{ migrated: number; skipped: number }> {
    const allEmployees = await this.getAllEmployeesIncludingDeleted();
    let migrated = 0;
    let skipped = 0;

    await db.transaction(async (tx) => {
      for (const employee of allEmployees) {
        if (!employee.idNumber || isAESEncrypted(employee.idNumber)) {
          skipped++;
          continue;
        }

        const displayId = getEmployeeDisplayId(employee);
        if (!displayId) {
          skipped++;
          continue;
        }

        const encryptedId = encryptEmployeeIdentityForStorage(displayId, true);

        const decryptedId = getEmployeeDisplayId({ idNumber: encryptedId, isEncrypted: true });
        if (normalizeEmployeeIdentity(decryptedId) !== normalizeEmployeeIdentity(displayId)) {
          throw new Error(`員工 ${employee.name} (ID: ${employee.id}) 加密驗證失敗`);
        }

        await tx
          .update(employees)
          .set({ idNumber: encryptedId, isEncrypted: true })
          .where(eq(employees.id, employee.id));

        log.info(`員工 ${employee.name} (ID: ${employee.id}) 身分證已加密為 AES-256-GCM`);
        migrated++;
      }
    });

    if (migrated > 0) {
      this.invalidateIdentityLookupCache();
    }

    return { migrated, skipped };
  }

  private async trashEmployee(id: number, deletedBy: string): Promise<Employee | undefined> {
    const deletedAt = new Date();
    const purgeAfterAt = addDays(deletedAt, EMPLOYEE_RECYCLE_RETENTION_DAYS);

    return db.transaction(async (tx) => {
      const [currentEmployee] = await tx.select().from(employees).where(eq(employees.id, id));

      if (!currentEmployee || currentEmployee.deletedAt) {
        return undefined;
      }

      await tx.delete(pendingBindings).where(eq(pendingBindings.employeeId, id));

      const [trashedEmployee] = await tx
        .update(employees)
        .set({
          deletedAt,
          deletedBy,
          purgeAfterAt,
          lineUserId: null,
          lineDisplayName: null,
          linePictureUrl: null,
          lineBindingDate: null
        })
        .where(eq(employees.id, id))
        .returning();

      return trashedEmployee;
    });
  }

  private async anonymizeRetainedSalaryRecordsForEmployee(
    executor: SalaryRecordMutationExecutor,
    employee: Employee,
    deletedAt: Date,
    deletedBy: string | null
  ): Promise<number> {
    const records = await executor
      .select()
      .from(salaryRecords)
      .where(eq(salaryRecords.employeeId, employee.id));

    if (records.length === 0) {
      return 0;
    }

    const retentionUntil = addYears(deletedAt, SALARY_RETENTION_YEARS);
    const employeeSnapshot = buildDeletedEmployeeSnapshot(employee, deletedAt, deletedBy);

    for (const record of records) {
      await executor
        .update(salaryRecords)
        .set({
          employeeId: null,
          employeeName: ANONYMIZED_EMPLOYEE_NAME,
          attendanceData: anonymizeAttendanceSnapshot(record.attendanceData),
          anonymizedAt: record.anonymizedAt ?? deletedAt,
          retentionUntil: record.retentionUntil ?? retentionUntil,
          employeeSnapshot: record.employeeSnapshot ?? employeeSnapshot
        })
        .where(eq(salaryRecords.id, record.id));
    }

    return records.length;
  }
}
