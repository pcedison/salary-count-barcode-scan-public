# Storage Repository Split (Salary + Monthly Salary Run) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move all salary-record and monthly-salary-run data access out of the 1053-line `server/storage.ts` God Object into two focused repositories, and repoint every one of the 9 files that touches those methods to import the repository directly instead of going through `storage`.

**Architecture:** `server/repositories/salaryRepository.ts` (new) and `server/repositories/monthlySalaryRunRepository.ts` (created in the race-condition-fix plan, extended here) become the sole owners of the `salaryRecords` and `monthlySalaryRuns` tables. `IStorage`/`DatabaseStorage` in `server/storage.ts` lose those methods entirely — no delegating wrapper, so there's exactly one way to reach this data going forward.

**Tech Stack:** TypeScript, Drizzle ORM, PostgreSQL, Vitest.

**Related spec:** `docs/superpowers/specs/2026-07-01-storage-repository-split-design.md`

**Prerequisite:** This plan assumes `docs/superpowers/plans/2026-07-01-monthly-salary-run-race-condition-fix.md` has already been executed (it creates `server/repositories/monthlySalaryRunRepository.ts` with `acquireRun`, which this plan extends).

---

## File Structure

- **Create:** `server/repositories/salaryRepository.ts`
- **Modify:** `server/repositories/monthlySalaryRunRepository.ts` — add the 4 methods not covered by the race-condition-fix plan.
- **Modify (9 call-site files):** `server/services/monthlySalaryAutomation.ts`, `server/services/monthlySalaryAutomation.test.ts`, `server/routes/salary.routes.ts`, `server/routes/salary.routes.integration.test.ts`, `server/routes/e2e-salary-flow.integration.test.ts`, `server/routes/salaryAutomation.routes.ts`, `server/routes/import.routes.ts`, `server/routes/import.routes.integration.test.ts`, `server/db-monitoring.ts`, `server/db-monitoring.test.ts`, `server/employee-retention.ts`, `server/employee-retention.test.ts`, `server/storage.real-db.test.ts`, `server/storage.retention.real-db.test.ts`.
- **Modify:** `server/storage.ts` — remove `SalaryRecordPageFilters`, `SalaryRecordYearFilters`, `buildSalaryRecordPageWhere`, the salary/monthly-run entries in `IStorage`, and their `DatabaseStorage` implementations.

(14 files total once test files are counted individually — the design doc's "9 files" refers to distinct call-site *modules*; several have a paired test file, both listed above.)

---

### Task 1: Create `salaryRepository.ts`

**Files:**
- Create: `server/repositories/salaryRepository.ts`

- [ ] **Step 1: Write the repository**

```typescript
import { and, desc, eq, ilike, isNotNull, lte, or, sql as drizzleSql, type SQL } from 'drizzle-orm';

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
```

- [ ] **Step 2: Typecheck**

Run: `npm run check`
Expected: PASS (this file has no consumers yet, so it just needs to compile on its own).

- [ ] **Step 3: Commit**

```bash
git add server/repositories/salaryRepository.ts
git commit -m "feat: add salaryRepository, extracted from storage.ts"
```

---

### Task 2: Extend `monthlySalaryRunRepository.ts` with the remaining 4 methods

**Files:**
- Modify: `server/repositories/monthlySalaryRunRepository.ts`

- [ ] **Step 1: Update the drizzle-orm import to add `desc`**

Change:

```typescript
import { and, eq, ne } from 'drizzle-orm';
```

to:

```typescript
import { and, desc, eq, ne } from 'drizzle-orm';
```

- [ ] **Step 2: Add 4 methods to `DatabaseMonthlySalaryRunRepository`**

Add these methods inside the class, after `acquireRun`:

```typescript
  async getMonthlySalaryRun(year: number, month: number): Promise<MonthlySalaryRun | undefined> {
    const [run] = await db
      .select()
      .from(monthlySalaryRuns)
      .where(
        and(
          eq(monthlySalaryRuns.salaryYear, year),
          eq(monthlySalaryRuns.salaryMonth, month)
        )
      );
    return run;
  }

  async getRecentMonthlySalaryRuns(limit = 12): Promise<MonthlySalaryRun[]> {
    return db
      .select()
      .from(monthlySalaryRuns)
      .orderBy(desc(monthlySalaryRuns.startedAt))
      .limit(limit);
  }

  async createMonthlySalaryRun(run: InsertMonthlySalaryRun): Promise<MonthlySalaryRun> {
    const [createdRun] = await db.insert(monthlySalaryRuns).values(run).returning();
    return createdRun;
  }

  async updateMonthlySalaryRun(
    id: number,
    run: Partial<InsertMonthlySalaryRun> & {
      completedAt?: Date | null;
      emailSentAt?: Date | null;
    }
  ): Promise<MonthlySalaryRun | undefined> {
    const [updatedRun] = await db
      .update(monthlySalaryRuns)
      .set(run as typeof monthlySalaryRuns.$inferInsert)
      .where(eq(monthlySalaryRuns.id, id))
      .returning();
    return updatedRun;
  }
```

- [ ] **Step 3: Run the existing real-db test for this repository**

Run: `npx vitest run --config vitest.real-db.config.ts server/repositories/monthlySalaryRunRepository.real-db.test.ts`
Expected: PASS (these new methods aren't exercised by that test yet, so this just confirms the file still compiles and `acquireRun` still works).

- [ ] **Step 4: Commit**

```bash
git add server/repositories/monthlySalaryRunRepository.ts
git commit -m "feat: add remaining CRUD methods to monthlySalaryRunRepository"
```

---

### Task 3: Repoint `storage.real-db.test.ts` at the new repositories

**Files:**
- Modify: `server/storage.real-db.test.ts`

- [ ] **Step 1: Add the import**

Directly below `import { storage } from './storage';` (line 25), add:

```typescript
import { salaryRepository } from './repositories/salaryRepository';
```

- [ ] **Step 2: Update the two salary-record assertions**

Replace (currently lines 748-758):

```typescript
describe('real database — salary records', () => {
  it('lists salary records without error', async () => {
    const records = await storage.getAllSalaryRecords();
    expect(Array.isArray(records)).toBe(true);
  });

  it('looks up salary record by year/month', async () => {
    const record = await storage.getSalaryRecordByYearMonth(2099, 1);
    expect(record === undefined || typeof record.id === 'number').toBe(true);
  });
});
```

with:

```typescript
describe('real database — salary records', () => {
  it('lists salary records without error', async () => {
    const records = await salaryRepository.getAllSalaryRecords();
    expect(Array.isArray(records)).toBe(true);
  });

  it('looks up salary record by year/month', async () => {
    const record = await salaryRepository.getSalaryRecordByYearMonth(2099, 1);
    expect(record === undefined || typeof record.id === 'number').toBe(true);
  });
});
```

- [ ] **Step 3: Run the test**

Run: `npx vitest run --config vitest.real-db.config.ts server/storage.real-db.test.ts`
Expected: PASS. (Note: this file isn't in the `test:real-db` composite script today — it's run manually/in CI separately. No wiring change needed here.)

- [ ] **Step 4: Commit**

```bash
git add server/storage.real-db.test.ts
git commit -m "test: repoint storage.real-db.test.ts salary assertions at salaryRepository"
```

---

### Task 4: Repoint `storage.retention.real-db.test.ts` at the new repositories

**Files:**
- Modify: `server/storage.retention.real-db.test.ts`

- [ ] **Step 1: Add the dynamic-import variable**

Directly below `let db: typeof import('./db').db;` (line 17), add:

```typescript
let salaryRepository: typeof import('./repositories/salaryRepository').salaryRepository;
```

- [ ] **Step 2: Import it in the dynamic-import `beforeAll`**

Change (lines 139-143):

```typescript
beforeAll(async () => {
  ({ storage } = await import('./storage'));
  ({ db } = await import('./db'));
  ({ runEmployeeRetentionCycle } = await import('./employee-retention'));
});
```

to:

```typescript
beforeAll(async () => {
  ({ storage } = await import('./storage'));
  ({ db } = await import('./db'));
  ({ salaryRepository } = await import('./repositories/salaryRepository'));
  ({ runEmployeeRetentionCycle } = await import('./employee-retention'));
});
```

- [ ] **Step 3: Update the `cleanup()` helper**

Change (line 79, inside `cleanup()`):

```typescript
  for (const salaryRecordId of trackedSalaryRecordIds) {
    try {
      await storage.deleteSalaryRecord(salaryRecordId);
    } catch {
      // ignore cleanup failures
    }
  }
```

to:

```typescript
  for (const salaryRecordId of trackedSalaryRecordIds) {
    try {
      await salaryRepository.deleteSalaryRecord(salaryRecordId);
    } catch {
      // ignore cleanup failures
    }
  }
```

- [ ] **Step 4: Update `createSalaryRecordForEmployee`**

Change (line 101):

```typescript
  const salaryRecord = await storage.createSalaryRecord({
```

to:

```typescript
  const salaryRecord = await salaryRepository.createSalaryRecord({
```

- [ ] **Step 5: Update the 3 `getSalaryRecordById` call sites**

Change all three occurrences (lines 275, 343, 353) from `storage.getSalaryRecordById(...)` to `salaryRepository.getSalaryRecordById(...)`. All three are simple `await storage.getSalaryRecordById(salaryRecord.id)` calls — replace `storage.` with `salaryRepository.` at each.

- [ ] **Step 6: Run the test**

Run: `npm run test:real-db:retention`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add server/storage.retention.real-db.test.ts
git commit -m "test: repoint storage.retention.real-db.test.ts salary calls at salaryRepository"
```

---

### Task 5: Migrate `monthlySalaryAutomation.ts` and its unit test

**Files:**
- Modify: `server/services/monthlySalaryAutomation.ts`
- Modify: `server/services/monthlySalaryAutomation.test.ts`

- [ ] **Step 1: Add the import**

Directly below `import { monthlySalaryRunRepository } from '../repositories/monthlySalaryRunRepository';` (added by the race-condition-fix plan), add:

```typescript
import { salaryRepository } from '../repositories/salaryRepository';
```

- [ ] **Step 2: Update `markRunFailed`**

Change:

```typescript
async function markRunFailed(run: MonthlySalaryRun | undefined, error: unknown) {
  if (!run) {
    return undefined;
  }

  const message = error instanceof Error ? error.message : String(error);
  return storage.updateMonthlySalaryRun(run.id, {
    status: 'failed',
    errorMessage: message,
    completedAt: new Date(),
  });
}
```

to:

```typescript
async function markRunFailed(run: MonthlySalaryRun | undefined, error: unknown) {
  if (!run) {
    return undefined;
  }

  const message = error instanceof Error ? error.message : String(error);
  return monthlySalaryRunRepository.updateMonthlySalaryRun(run.id, {
    status: 'failed',
    errorMessage: message,
    completedAt: new Date(),
  });
}
```

- [ ] **Step 3: Update the skip-return inside `runMonthlySalaryAutomation`**

Change (inside the `if (acquireResult.skipReason)` block added by the race-condition-fix plan):

```typescript
          persistedRecords: await storage.getSalaryRecordsByYearMonth(target.year, target.month),
```

to:

```typescript
          persistedRecords: await salaryRepository.getSalaryRecordsByYearMonth(target.year, target.month),
```

- [ ] **Step 4: Update the per-employee loop**

Change:

```typescript
      const existingRecord = await storage.getSalaryRecordByYearMonthEmployee(
        target.year,
        target.month,
        employee.id
      );
```

to:

```typescript
      const existingRecord = await salaryRepository.getSalaryRecordByYearMonthEmployee(
        target.year,
        target.month,
        employee.id
      );
```

And change:

```typescript
      const persistedRecord = existingRecord
        ? await storage.updateSalaryRecord(existingRecord.id, finalRecord)
        : await storage.createSalaryRecord(finalRecord);
```

to:

```typescript
      const persistedRecord = existingRecord
        ? await salaryRepository.updateSalaryRecord(existingRecord.id, finalRecord)
        : await salaryRepository.createSalaryRecord(finalRecord);
```

- [ ] **Step 5: Update the "no records generated" skip**

Change:

```typescript
      const updatedRun = run
        ? await storage.updateMonthlySalaryRun(run.id, {
            status: 'skipped',
            recordCount: 0,
            skippedCount: skippedEmployees.length,
            errorMessage: 'No salary records were generated.',
            completedAt: new Date(),
          })
        : undefined;
```

to:

```typescript
      const updatedRun = run
        ? await monthlySalaryRunRepository.updateMonthlySalaryRun(run.id, {
            status: 'skipped',
            recordCount: 0,
            skippedCount: skippedEmployees.length,
            errorMessage: 'No salary records were generated.',
            completedAt: new Date(),
          })
        : undefined;
```

- [ ] **Step 6: Update the succeeded-completion update**

Change:

```typescript
    const updatedRun = run
      ? await storage.updateMonthlySalaryRun(run.id, {
          status: 'succeeded',
          recordCount: persistedRecords.length,
          skippedCount: skippedEmployees.length,
          pdfPath,
          emailTo: emailRecipients,
          emailSentAt: sendEmail ? new Date() : null,
          errorMessage: null,
          completedAt: new Date(),
        })
      : undefined;
```

to:

```typescript
    const updatedRun = run
      ? await monthlySalaryRunRepository.updateMonthlySalaryRun(run.id, {
          status: 'succeeded',
          recordCount: persistedRecords.length,
          skippedCount: skippedEmployees.length,
          pdfPath,
          emailTo: emailRecipients,
          emailSentAt: sendEmail ? new Date() : null,
          errorMessage: null,
          completedAt: new Date(),
        })
      : undefined;
```

`storage` is no longer referenced anywhere in this file after these changes except `storage.getSettings()`, `storage.getAllEmployees()`, and `storage.getTemporaryAttendanceByEmployeeAndMonth(...)` — those stay, they're settings/employee/attendance domain and out of scope.

- [ ] **Step 7: Update the unit test mocks**

In `server/services/monthlySalaryAutomation.test.ts`, the `monthlySalaryRunRepositoryMock` already exists from the race-condition-fix plan. Add a `salaryRepositoryMock` alongside it and move the salary-record entries out of `storageMock`.

Replace the current `storageMock` (post race-condition-fix-plan version, containing `updateMonthlySalaryRun`, `getSalaryRecordsByYearMonth`, `getSalaryRecordByYearMonthEmployee`, `getSettings`, `getAllEmployees`, `getTemporaryAttendanceByEmployeeAndMonth`, `createSalaryRecord`, `updateSalaryRecord`) with:

```typescript
const storageMock = vi.hoisted(() => ({
  getSettings: vi.fn(async () => state.settings),
  getAllEmployees: vi.fn(async () => state.employees),
  getTemporaryAttendanceByEmployeeAndMonth: vi.fn(async (employeeId: number) =>
    state.attendance.filter((record) => record.employeeId === employeeId)
  ),
}));

const salaryRepositoryMock = vi.hoisted(() => ({
  getSalaryRecordsByYearMonth: vi.fn(async (year: number, month: number) =>
    state.salaryRecords.filter((record) => record.salaryYear === year && record.salaryMonth === month)
  ),
  getSalaryRecordByYearMonthEmployee: vi.fn(async (year: number, month: number, employeeId: number) =>
    state.salaryRecords.find(
      (record) =>
        record.salaryYear === year &&
        record.salaryMonth === month &&
        record.employeeId === employeeId
    )
  ),
  createSalaryRecord: vi.fn(async (record: Record<string, any>) => {
    const created = { ...record, id: state.salaryRecords.length + 1, createdAt: new Date() };
    state.salaryRecords.push(created);
    return created;
  }),
  updateSalaryRecord: vi.fn(async (id: number, data: Record<string, any>) => {
    const record = state.salaryRecords.find((item) => item.id === id);
    if (!record) return undefined;
    Object.assign(record, data);
    return record;
  }),
}));
```

`monthlySalaryRunRepositoryMock.acquireRun` (from the race-condition-fix plan) also needs `updateMonthlySalaryRun` added, since `markRunFailed` and the completion/skip updates now call it instead of `storage`:

```typescript
const monthlySalaryRunRepositoryMock = vi.hoisted(() => ({
  acquireRun: vi.fn(
    async (params: {
      year: number;
      month: number;
      runKey: string;
      force: boolean;
      emailRecipients: string[];
    }) => {
      const existing = state.salaryRuns.find(
        (run) => run.salaryYear === params.year && run.salaryMonth === params.month
      );

      if (existing?.status === 'succeeded' && !params.force) {
        return { run: existing, skipReason: 'monthly salary run already succeeded' };
      }

      if (existing?.status === 'running' && !params.force) {
        return { run: existing, skipReason: 'monthly salary run is already running' };
      }

      if (existing) {
        Object.assign(existing, {
          status: 'running',
          recordCount: 0,
          skippedCount: 0,
          pdfPath: null,
          emailTo: params.emailRecipients,
          emailSentAt: null,
          errorMessage: null,
          completedAt: null,
        });
        return { run: existing };
      }

      const created = {
        id: state.salaryRuns.length + 1,
        runKey: params.runKey,
        salaryYear: params.year,
        salaryMonth: params.month,
        status: 'running',
        recordCount: 0,
        skippedCount: 0,
        emailTo: params.emailRecipients,
        startedAt: new Date(),
      };
      state.salaryRuns.push(created);
      return { run: created };
    }
  ),
  updateMonthlySalaryRun: vi.fn(async (id: number, data: Record<string, any>) => {
    const run = state.salaryRuns.find((item) => item.id === id);
    if (!run) return undefined;
    Object.assign(run, data);
    return run;
  }),
}));
```

- [ ] **Step 8: Register the new mock module**

Below the existing `vi.mock('../repositories/monthlySalaryRunRepository', ...)` line, add:

```typescript
vi.mock('../repositories/salaryRepository', () => ({
  salaryRepository: salaryRepositoryMock,
}));
```

- [ ] **Step 9: Run the test**

Run: `npx vitest run server/services/monthlySalaryAutomation.test.ts`
Expected: PASS — all tests green, including the assertion `expect(storageMock.updateMonthlySalaryRun).toHaveBeenLastCalledWith(...)`, which must now be changed to `expect(monthlySalaryRunRepositoryMock.updateMonthlySalaryRun).toHaveBeenLastCalledWith(...)` (same arguments, id `1`, `status: 'succeeded'`, etc. — only the mock object being asserted on changes).

- [ ] **Step 10: Commit**

```bash
git add server/services/monthlySalaryAutomation.ts server/services/monthlySalaryAutomation.test.ts
git commit -m "refactor: migrate monthlySalaryAutomation.ts to salaryRepository/monthlySalaryRunRepository"
```

---

### Task 6: Migrate `salary.routes.ts` and its integration tests

**Files:**
- Modify: `server/routes/salary.routes.ts`
- Modify: `server/routes/salary.routes.integration.test.ts`
- Modify: `server/routes/e2e-salary-flow.integration.test.ts`

- [ ] **Step 1: Add the import**

Directly below `import { storage } from '../storage';` (line 7), add:

```typescript
import { salaryRepository } from '../repositories/salaryRepository';
```

- [ ] **Step 2: Replace the 9 salary-record call sites**

In `registerSalaryRoutes`, change `storage.` to `salaryRepository.` for these calls only (leave `storage.getSettings`, `storage.getTemporaryAttendanceByEmployeeAndMonth`, `storage.getTemporaryAttendance` untouched):

| Line (before this task) | Before | After |
|---|---|---|
| 238 | `await storage.getAllSalaryRecordsPage(page, limit, filters)` | `await salaryRepository.getAllSalaryRecordsPage(page, limit, filters)` |
| 239 | `await storage.getAllSalaryRecordsPage(page, limit)` | `await salaryRepository.getAllSalaryRecordsPage(page, limit)` |
| 252 | `await storage.getSalaryRecordYears(filters)` | `await salaryRepository.getSalaryRecordYears(filters)` |
| 253 | `await storage.getSalaryRecordYears()` | `await salaryRepository.getSalaryRecordYears()` |
| 273 | `const record = await storage.getSalaryRecordById(id);` (inside `/print-batch`) | `const record = await salaryRepository.getSalaryRecordById(id);` |
| 293 | `const record = await storage.getSalaryRecordById(id);` (inside `GET /:id`) | `const record = await salaryRepository.getSalaryRecordById(id);` |
| 313 | `const record = await storage.createSalaryRecord(finalData);` | `const record = await salaryRepository.createSalaryRecord(finalData);` |
| 333 | `const existingRecord = await storage.getSalaryRecordById(id);` (inside `PATCH /:id`) | `const existingRecord = await salaryRepository.getSalaryRecordById(id);` |
| 369 | `const record = await storage.updateSalaryRecord(id, updateData);` | `const record = await salaryRepository.updateSalaryRecord(id, updateData);` |
| 387 | `const deleted = await storage.deleteSalaryRecord(id);` | `const deleted = await salaryRepository.deleteSalaryRecord(id);` |
| 478 | `const record = await storage.getSalaryRecordById(id);` (inside `GET /:id/pdf`) | `const record = await salaryRepository.getSalaryRecordById(id);` |

- [ ] **Step 3: Update `salary.routes.integration.test.ts`**

Replace the current `storageMock` (lines 67-96) with:

```typescript
const storageMock = vi.hoisted(() => ({
  getSettings: vi.fn(async () => salaryState.settings),
  getTemporaryAttendance: vi.fn(async () => []),
  getTemporaryAttendanceByEmployeeAndMonth: vi.fn(async () => []),
}));

const salaryRepositoryMock = vi.hoisted(() => ({
  getAllSalaryRecords: vi.fn(async () => salaryState.records),
  getAllSalaryRecordsPage: vi.fn(async (page: number, limit: number) => ({
    rows: salaryState.records.slice(0, limit),
    total: salaryState.records.length,
    page,
    limit
  })),
  getSalaryRecordYears: vi.fn(async () =>
    Array.from(new Set(salaryState.records.map((record) => Number(record.salaryYear))))
      .sort((a, b) => b - a)
  ),
  getSalaryRecordById: vi.fn(async (id: number) =>
    salaryState.records.find((record) => record.id === id)
  ),
  updateSalaryRecord: vi.fn(async (id: number, data: Record<string, unknown>) => {
    salaryState.lastUpdate = { id, data };
    const record = salaryState.records.find((item) => item.id === id);

    if (!record) {
      return undefined;
    }

    Object.assign(record, data);
    return record;
  })
}));
```

Directly below the existing `vi.mock('../storage', () => ({ storage: storageMock }))` block, add:

```typescript
vi.mock('../repositories/salaryRepository', () => ({
  salaryRepository: salaryRepositoryMock,
}));
```

Then update every `storageMock.getAllSalaryRecordsPage` / `storageMock.getAllSalaryRecords` / `storageMock.getSalaryRecordYears` / `storageMock.updateSalaryRecord` assertion in the rest of the file (lines 233, 234, 293, 329, 406, 474) to reference `salaryRepositoryMock` instead — same method name, same arguments, only the mock object changes. (`storageMock.getTemporaryAttendance` at line 404 and `storageMock.getTemporaryAttendanceByEmployeeAndMonth` at line 454 stay as `storageMock`.)

- [ ] **Step 4: Update `e2e-salary-flow.integration.test.ts`**

Replace the current `storageMock` (lines 77-136) with:

```typescript
const storageMock = vi.hoisted(() => ({
  // employee layer
  getAllEmployees: vi.fn(async () => state.employees),
  getEmployeeById: vi.fn(async (id: number) =>
    state.employees.find((e) => e.id === id)
  ),

  // attendance layer
  getTemporaryAttendance: vi.fn(async () => state.attendance),
  getTemporaryAttendancePage: vi.fn(async (page: number, limit: number) => ({
    rows: state.attendance.slice(0, limit),
    total: state.attendance.length,
    page,
    limit,
  })),
  getTemporaryAttendanceByEmployeeAndMonth: vi.fn(async (employeeId: number, year: number, month: number) =>
    state.attendance.filter((record) => {
      const normalizedDate = String(record.date ?? '').replace(/\//g, '-');
      return (
        record.employeeId === employeeId &&
        normalizedDate.startsWith(`${year}-${String(month).padStart(2, '0')}-`)
      );
    })
  ),
  createTemporaryAttendance: vi.fn(async (record: Record<string, unknown>) => {
    const created = { ...record, id: state.nextAttendanceId++, createdAt: new Date() };
    state.attendance.push(created);
    return created;
  }),
  deleteAllTemporaryAttendance: vi.fn(async () => {
    state.attendance = [];
    return true;
  }),

  // settings layer
  getSettings: vi.fn(async () => state.settings),
}));

const salaryRepositoryMock = vi.hoisted(() => ({
  getAllSalaryRecords: vi.fn(async () => state.salaryRecords),
  getAllSalaryRecordsPage: vi.fn(async (page: number, limit: number) => ({
    rows: state.salaryRecords.slice(0, limit),
    total: state.salaryRecords.length,
    page,
    limit,
  })),
  getSalaryRecordById: vi.fn(async (id: number) =>
    state.salaryRecords.find((r) => r.id === id)
  ),
  createSalaryRecord: vi.fn(async (record: Record<string, unknown>) => {
    const created = { ...record, id: state.nextSalaryId++, createdAt: new Date() };
    state.salaryRecords.push(created);
    return created;
  }),
  updateSalaryRecord: vi.fn(async (id: number, data: Record<string, unknown>) => {
    const record = state.salaryRecords.find((r) => r.id === id);
    if (!record) return undefined;
    Object.assign(record, data);
    return record;
  }),
}));
```

Directly below `vi.mock('../storage', () => ({ storage: storageMock }));`, add:

```typescript
vi.mock('../repositories/salaryRepository', () => ({
  salaryRepository: salaryRepositoryMock,
}));
```

Then update the `storageMock.createSalaryRecord` assertion at line 337 to `salaryRepositoryMock.createSalaryRecord`.

- [ ] **Step 5: Run both integration tests**

Run: `npx vitest run server/routes/salary.routes.integration.test.ts server/routes/e2e-salary-flow.integration.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/routes/salary.routes.ts server/routes/salary.routes.integration.test.ts server/routes/e2e-salary-flow.integration.test.ts
git commit -m "refactor: migrate salary.routes.ts to salaryRepository"
```

---

### Task 7: Migrate `salaryAutomation.routes.ts`

**Files:**
- Modify: `server/routes/salaryAutomation.routes.ts`

- [ ] **Step 1: Add the import**

Directly below `import { storage } from '../storage';` (line 6), add:

```typescript
import { monthlySalaryRunRepository } from '../repositories/monthlySalaryRunRepository';
```

- [ ] **Step 2: Replace the one call site**

Change:

```typescript
      const runs = await storage.getRecentMonthlySalaryRuns(limit);
```

to:

```typescript
      const runs = await monthlySalaryRunRepository.getRecentMonthlySalaryRuns(limit);
```

`storage` is no longer used anywhere else in this file — remove the now-unused `import { storage } from '../storage';` line entirely.

- [ ] **Step 3: Run the full suite (no dedicated test file for this route)**

Run: `npx vitest run`
Expected: PASS — no test file directly exercises `/api/salary-automation/runs`, but `runMonthlySalaryAutomation` (called by the sibling `/api/salary-automation/run` route, unchanged by this task) is covered by `monthlySalaryAutomation.test.ts`, already green from Task 5.

- [ ] **Step 4: Manual smoke check**

Start the dev server (`npm run dev`) and confirm `GET /api/salary-automation/runs` (admin session required) returns the recent-runs list as before. Since this endpoint has no automated test, this manual check is the only verification for this specific route — record the result in the PR description.

- [ ] **Step 5: Commit**

```bash
git add server/routes/salaryAutomation.routes.ts
git commit -m "refactor: migrate salaryAutomation.routes.ts to monthlySalaryRunRepository"
```

---

### Task 8: Migrate `import.routes.ts` and its integration test

**Files:**
- Modify: `server/routes/import.routes.ts`
- Modify: `server/routes/import.routes.integration.test.ts`

- [ ] **Step 1: Add the import**

Directly below `import { storage } from '../storage';` (line 5), add:

```typescript
import { salaryRepository } from '../repositories/salaryRepository';
```

- [ ] **Step 2: Update `findExistingSalaryImportRecord`**

Change:

```typescript
async function findExistingSalaryImportRecord(salaryRecord: SalaryRecordImportPayload) {
  if (salaryRecord.employeeId) {
    return storage.getSalaryRecordByYearMonthEmployee(
      salaryRecord.salaryYear,
      salaryRecord.salaryMonth,
      salaryRecord.employeeId
    );
  }

  const recordsForMonth = await storage.getSalaryRecordsByYearMonth(
    salaryRecord.salaryYear,
    salaryRecord.salaryMonth
  );
```

to:

```typescript
async function findExistingSalaryImportRecord(salaryRecord: SalaryRecordImportPayload) {
  if (salaryRecord.employeeId) {
    return salaryRepository.getSalaryRecordByYearMonthEmployee(
      salaryRecord.salaryYear,
      salaryRecord.salaryMonth,
      salaryRecord.employeeId
    );
  }

  const recordsForMonth = await salaryRepository.getSalaryRecordsByYearMonth(
    salaryRecord.salaryYear,
    salaryRecord.salaryMonth
  );
```

- [ ] **Step 3: Update the create/update call sites**

Change:

```typescript
      if (existingRecord) {
        const updatedRecord = await storage.updateSalaryRecord(existingRecord.id, salaryRecordPayload);
```

to:

```typescript
      if (existingRecord) {
        const updatedRecord = await salaryRepository.updateSalaryRecord(existingRecord.id, salaryRecordPayload);
```

Change:

```typescript
      const createdRecord = await storage.createSalaryRecord(salaryRecordPayload);
```

to:

```typescript
      const createdRecord = await salaryRepository.createSalaryRecord(salaryRecordPayload);
```

`storage.createTemporaryAttendance` (used by the attendance-import route) stays untouched — `storage` import remains needed for that.

- [ ] **Step 4: Update `import.routes.integration.test.ts`**

Replace the current `storageMock` (lines 14-56) with:

```typescript
const storageMock = vi.hoisted(() => ({
  createTemporaryAttendance: vi.fn(async (payload: Record<string, unknown>) => {
    importState.attendanceInserts.push(payload);
    return {
      id: importState.attendanceInserts.length,
      ...payload,
      createdAt: new Date('2026-03-12T00:00:00.000Z')
    };
  }),
}));

const salaryRepositoryMock = vi.hoisted(() => ({
  getSalaryRecordByYearMonth: vi.fn(async () => importState.existingSalaryRecord),
  getSalaryRecordsByYearMonth: vi.fn(async () =>
    importState.existingSalaryRecords.length > 0
      ? importState.existingSalaryRecords
      : importState.existingSalaryRecord
        ? [importState.existingSalaryRecord]
        : []
  ),
  getSalaryRecordByYearMonthEmployee: vi.fn(async (_year: number, _month: number, employeeId: number) =>
    importState.existingSalaryRecords.find((record) => record.employeeId === employeeId) ||
    (
      importState.existingSalaryRecord &&
      importState.existingSalaryRecord.employeeId === employeeId
        ? importState.existingSalaryRecord
        : undefined
    )
  ),
  updateSalaryRecord: vi.fn(async (id: number, payload: Record<string, unknown>) => {
    importState.updatedSalaryPayload = payload;
    return {
      id,
      ...payload,
      createdAt: new Date('2026-03-12T00:00:00.000Z')
    };
  }),
  createSalaryRecord: vi.fn(async (payload: Record<string, unknown>) => {
    importState.createdSalaryPayload = payload;
    return {
      id: 99,
      ...payload,
      createdAt: new Date('2026-03-12T00:00:00.000Z')
    };
  })
}));
```

Directly below `vi.mock('../storage', () => ({ storage: storageMock }));`, add:

```typescript
vi.mock('../repositories/salaryRepository', () => ({
  salaryRepository: salaryRepositoryMock,
}));
```

Then update every `storageMock.updateSalaryRecord` / `storageMock.createSalaryRecord` / `storageMock.getSalaryRecordByYearMonthEmployee` assertion later in the file (lines 213, 276, 277, 322, 323, 374, 375) to `salaryRepositoryMock.*` instead — same method/argument shape.

- [ ] **Step 5: Run the test**

Run: `npx vitest run server/routes/import.routes.integration.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/routes/import.routes.ts server/routes/import.routes.integration.test.ts
git commit -m "refactor: migrate import.routes.ts to salaryRepository"
```

---

### Task 9: Migrate `db-monitoring.ts` and its test

**Files:**
- Modify: `server/db-monitoring.ts`
- Modify: `server/db-monitoring.test.ts`

- [ ] **Step 1: Add the import**

Directly below `import { storage } from './storage';` (line 10), add:

```typescript
import { salaryRepository } from './repositories/salaryRepository';
```

- [ ] **Step 2: Update `loadAuthoritativeBackupValue`**

Change:

```typescript
    case 'salaryRecords':
      return storage.getAllSalaryRecords();
```

to:

```typescript
    case 'salaryRecords':
      return salaryRepository.getAllSalaryRecords();
```

- [ ] **Step 3: Update the second call site**

Change:

```typescript
    // Include salary records.
    data.salaryRecords = await storage.getAllSalaryRecords();
```

to:

```typescript
    // Include salary records.
    data.salaryRecords = await salaryRepository.getAllSalaryRecords();
```

`storage` stays imported — this file still uses `storage.getAllEmployeesIncludingDeleted`, `storage.getSettings`, `storage.getAllHolidays`, `storage.getTemporaryAttendance`.

- [ ] **Step 4: Update `db-monitoring.test.ts`**

Change:

```typescript
vi.mock('./storage', () => ({
  storage: {
    getAllEmployees: getAllEmployeesMock,
    getAllEmployeesIncludingDeleted: getAllEmployeesMock,
    getSettings: getSettingsMock,
    getAllHolidays: getAllHolidaysMock,
    getAllSalaryRecords: getAllSalaryRecordsMock,
    getTemporaryAttendance: getTemporaryAttendanceMock,
    createEmployee: createEmployeeMock,
    createOrUpdateSettings: createOrUpdateSettingsMock,
    createHoliday: createHolidayMock,
    createSalaryRecord: createSalaryRecordMock,
    createTemporaryAttendance: createTemporaryAttendanceMock
  }
}));
```

to:

```typescript
vi.mock('./storage', () => ({
  storage: {
    getAllEmployees: getAllEmployeesMock,
    getAllEmployeesIncludingDeleted: getAllEmployeesMock,
    getSettings: getSettingsMock,
    getAllHolidays: getAllHolidaysMock,
    getTemporaryAttendance: getTemporaryAttendanceMock,
    createEmployee: createEmployeeMock,
    createOrUpdateSettings: createOrUpdateSettingsMock,
    createHoliday: createHolidayMock,
    createTemporaryAttendance: createTemporaryAttendanceMock
  }
}));

vi.mock('./repositories/salaryRepository', () => ({
  salaryRepository: {
    getAllSalaryRecords: getAllSalaryRecordsMock,
    createSalaryRecord: createSalaryRecordMock
  }
}));
```

(`createSalaryRecordMock` was already declared but unused by production code before this change — it's kept here in case a future restore-path test exercises it; moving it alongside `getAllSalaryRecordsMock` keeps the salary-record mocks together.)

- [ ] **Step 5: Run the test**

Run: `npx vitest run server/db-monitoring.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/db-monitoring.ts server/db-monitoring.test.ts
git commit -m "refactor: migrate db-monitoring.ts to salaryRepository"
```

---

### Task 10: Migrate `employee-retention.ts` and its test

**Files:**
- Modify: `server/employee-retention.ts`
- Modify: `server/employee-retention.test.ts`

- [ ] **Step 1: Add the import**

Directly below `import { storage } from './storage';` (line 2), add:

```typescript
import { salaryRepository } from './repositories/salaryRepository';
```

- [ ] **Step 2: Update `runEmployeeRetentionCycle`**

Change:

```typescript
  const { purgedEmployeeIds, anonymizedSalaryRecords } = await storage.purgeExpiredDeletedEmployees();
  const purgedSalaryRecords = await storage.purgeExpiredRetainedSalaryRecords();
```

to:

```typescript
  const { purgedEmployeeIds, anonymizedSalaryRecords } = await storage.purgeExpiredDeletedEmployees();
  const purgedSalaryRecords = await salaryRepository.purgeExpiredRetainedSalaryRecords();
```

- [ ] **Step 3: Update `employee-retention.test.ts`**

Change:

```typescript
const storageMock = vi.hoisted(() => ({
  purgeExpiredDeletedEmployees: vi.fn(async () => ({
    purgedEmployeeIds: [5],
    anonymizedSalaryRecords: 2
  })),
  purgeExpiredRetainedSalaryRecords: vi.fn(async () => 1)
}));

vi.mock('./storage', () => ({
  storage: storageMock
}));
```

to:

```typescript
const storageMock = vi.hoisted(() => ({
  purgeExpiredDeletedEmployees: vi.fn(async () => ({
    purgedEmployeeIds: [5],
    anonymizedSalaryRecords: 2
  }))
}));

const salaryRepositoryMock = vi.hoisted(() => ({
  purgeExpiredRetainedSalaryRecords: vi.fn(async () => 1)
}));

vi.mock('./storage', () => ({
  storage: storageMock
}));

vi.mock('./repositories/salaryRepository', () => ({
  salaryRepository: salaryRepositoryMock
}));
```

Then update every `storageMock.purgeExpiredRetainedSalaryRecords` assertion in the rest of the file (lines 39, 72, 79, 88) to `salaryRepositoryMock.purgeExpiredRetainedSalaryRecords`. `storageMock.purgeExpiredDeletedEmployees` assertions (lines 38, 71, 78, 87) stay as `storageMock`.

- [ ] **Step 4: Run the test**

Run: `npx vitest run server/employee-retention.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/employee-retention.ts server/employee-retention.test.ts
git commit -m "refactor: migrate employee-retention.ts to salaryRepository"
```

---

### Task 11: Remove salary/monthly-run methods from `storage.ts`

**Files:**
- Modify: `server/storage.ts`

At this point nothing calls `storage.getAllSalaryRecords`, `storage.getAllSalaryRecordsPage`, `storage.getSalaryRecordYears`, `storage.getSalaryRecordById`, `storage.getSalaryRecordByYearMonth`, `storage.getSalaryRecordsByYearMonth`, `storage.getSalaryRecordByYearMonthEmployee`, `storage.createSalaryRecord`, `storage.updateSalaryRecord`, `storage.deleteSalaryRecord`, `storage.purgeExpiredRetainedSalaryRecords`, `storage.getMonthlySalaryRun`, `storage.getRecentMonthlySalaryRuns`, `storage.createMonthlySalaryRun`, or `storage.updateMonthlySalaryRun` — confirm this first.

- [ ] **Step 1: Confirm there are no remaining references**

Run: `grep -rn "storage\.\(getAllSalaryRecords\|getSalaryRecord\|createSalaryRecord\|updateSalaryRecord\|deleteSalaryRecord\|purgeExpiredRetainedSalaryRecords\|MonthlySalaryRun\)" server --include="*.ts"`
Expected: no output (grep exits with no matches).

- [ ] **Step 2: Delete `SalaryRecordPageFilters`, `SalaryRecordYearFilters`, and `buildSalaryRecordPageWhere`**

Delete this block (currently lines 43-50):

```typescript
export interface SalaryRecordPageFilters {
  employeeId?: number;
  salaryYear?: number;
  salaryMonth?: number;
  search?: string;
}

export type SalaryRecordYearFilters = Omit<SalaryRecordPageFilters, 'salaryYear'>;
```

Delete this function (currently lines 167-198):

```typescript
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
```

(`toLikePattern`, directly above it, stays — it's still used by `buildTemporaryAttendancePageWhere` for the attendance domain.)

- [ ] **Step 3: Remove the salary/monthly-run entries from `IStorage`**

Delete these lines from the `IStorage` interface (currently lines 214, 235-244, 247-253):

```typescript
  purgeExpiredRetainedSalaryRecords(): Promise<number>;
```

```typescript
  getAllSalaryRecords(): Promise<SalaryRecord[]>;
  getAllSalaryRecordsPage(page: number, limit: number, filters?: SalaryRecordPageFilters): Promise<{ rows: SalaryRecord[]; total: number }>;
  getSalaryRecordYears(filters?: SalaryRecordYearFilters): Promise<number[]>;
  getSalaryRecordById(id: number): Promise<SalaryRecord | undefined>;
  getSalaryRecordByYearMonth(year: number, month: number): Promise<SalaryRecord | undefined>;
  getSalaryRecordsByYearMonth(year: number, month: number): Promise<SalaryRecord[]>;
  getSalaryRecordByYearMonthEmployee(year: number, month: number, employeeId: number): Promise<SalaryRecord | undefined>;
  createSalaryRecord(record: InsertSalaryRecord): Promise<SalaryRecord>;
  updateSalaryRecord(id: number, record: Partial<InsertSalaryRecord>): Promise<SalaryRecord | undefined>;
  deleteSalaryRecord(id: number): Promise<boolean>;
```

```typescript
  getMonthlySalaryRun(year: number, month: number): Promise<MonthlySalaryRun | undefined>;
  getRecentMonthlySalaryRuns(limit?: number): Promise<MonthlySalaryRun[]>;
  createMonthlySalaryRun(run: InsertMonthlySalaryRun): Promise<MonthlySalaryRun>;
  updateMonthlySalaryRun(id: number, run: Partial<InsertMonthlySalaryRun> & {
    completedAt?: Date | null;
    emailSentAt?: Date | null;
  }): Promise<MonthlySalaryRun | undefined>;
```

- [ ] **Step 4: Remove the `DatabaseStorage` implementations**

Delete the `purgeExpiredRetainedSalaryRecords` method (currently lines 348-362, sitting among the employee-purge methods, well before the separate `// Salary record methods` section handled below — leave the blank line above it and the following `// Temporary attendance methods` section header and its methods untouched):

```typescript
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
```

Delete the entire `// Salary record methods` block through the end of `updateMonthlySalaryRun` (currently lines 599-755 — from the `// Salary record methods` comment through the closing brace of `updateMonthlySalaryRun`, i.e. everything shown earlier in this plan's Task 1 and Task 2 "Step 1" code blocks that originated in `storage.ts`). What remains directly below is whatever came after `updateMonthlySalaryRun` in the original file (the next domain's methods) — leave that untouched.

- [ ] **Step 5: Remove now-unused imports**

`salaryRecords`, `type SalaryRecord`, `type InsertSalaryRecord`, `monthlySalaryRuns`, `type MonthlySalaryRun`, `type InsertMonthlySalaryRun` were imported from `@shared/schema` at the top of `storage.ts` (lines 11-12). Check whether any remaining code in `storage.ts` still references `SalaryRecord`, `InsertSalaryRecord`, `MonthlySalaryRun`, or `InsertMonthlySalaryRun` as types (e.g. in the `purgeEmployee`-adjacent employee methods that return `anonymizedSalaryRecords: number` — those are plain numbers, not the `SalaryRecord` type, so likely nothing does). If nothing does, remove those 6 identifiers from the import block; if something still does, leave the import for that identifier in place.

Also check whether `and`, `isNotNull`, `lte`, `or`, `ilike` (from the `drizzle-orm` import) are still used elsewhere in `storage.ts` (they are — `and`/`isNotNull`/`lte` are used by other domains' where-builders, `or`/`ilike` by `buildTemporaryAttendancePageWhere`). Leave the `drizzle-orm` import line as-is; only prune the `@shared/schema` entries confirmed unused.

- [ ] **Step 6: Typecheck**

Run: `npm run check`
Expected: PASS — no dangling references to the removed methods/types anywhere in the codebase.

- [ ] **Step 7: Run the full non-real-db suite**

Run: `npx vitest run`
Expected: PASS.

- [ ] **Step 8: Run the real-db suite**

Run: `npm run test:real-db`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add server/storage.ts
git commit -m "refactor: remove salary/monthly-run methods from storage.ts"
```

---

### Task 12: Final regression check

**Files:** none (verification only)

- [ ] **Step 1: Run the smoke suite**

Run: `npm run test:smoke`
Expected: PASS.

- [ ] **Step 2: Manual sanity check of the salary UI**

Start the dev server (`npm run dev`), log in as admin, and confirm: the salary records list loads and paginates, a salary record can be viewed/edited/deleted, and the salary automation "recent runs" list loads. This exercises every route touched by Tasks 6-7 end-to-end against a real database, which no single automated test in this plan does by itself.

---

## Self-Review Notes

- **Spec coverage:** All method-move items from the design doc's table are covered — salaryRepository (Task 1), monthlySalaryRunRepository extension (Task 2), all 9 call-site files (Tasks 5-10), IStorage/DatabaseStorage removal (Task 11). ✅
- **Placeholder scan:** No TBD/TODO; every step shows full before/after code except Task 11 Step 4's second deletion, which is intentionally described by line range + "everything shown in Task 1/2" because reproducing ~155 lines of code already shown verbatim earlier in this same document would be pure duplication — the instruction is unambiguous (delete from the named comment through the named closing brace). ✅
- **Type consistency:** `salaryRepository`/`monthlySalaryRunRepository` method names and parameter shapes are identical to what `storage.ts` had, so every call site is a mechanical `storage.` → `salaryRepository.`/`monthlySalaryRunRepository.` rename with no signature changes. Verified consistent across Tasks 1, 2, 5, 6, 7, 8, 9, 10. ✅
- **Ordering:** Tasks 1-4 (new repositories + real-db test repointing) come before Tasks 5-10 (call-site migration) come before Task 11 (deletion from `storage.ts`), so at every commit boundary the codebase compiles and all tests pass — `storage.ts` isn't touched until nothing references the old methods anymore. ✅
