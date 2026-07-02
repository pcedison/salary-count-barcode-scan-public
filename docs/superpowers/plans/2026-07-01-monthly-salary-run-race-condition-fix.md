# Monthly Salary Run Race Condition Fix — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `monthly_salary_runs` acquisition atomic so two concurrent triggers (manual `POST /api/salary-automation/run` and the scheduler tick) can never both start a run for the same month, and make sure any acquisition error is caught and recorded instead of crashing unhandled.

**Architecture:** Move the "read run → decide → create/update" logic out of `server/services/monthlySalaryAutomation.ts` and into a new `server/repositories/monthlySalaryRunRepository.ts`, implemented as a single Postgres `INSERT ... ON CONFLICT (salaryYear, salaryMonth) DO UPDATE ... SET ... WHERE <condition>` statement using Drizzle's `onConflictDoUpdate({ setWhere })`. The existing `monthly_salary_runs_year_month_uniq` unique constraint (`shared/schema.ts:170`) is the conflict target — no schema change needed.

**Tech Stack:** TypeScript, Drizzle ORM (`^0.45.2`), PostgreSQL, Vitest (`vitest.config.ts` for mocked unit tests, `vitest.real-db.config.ts` for real-database tests).

**Related spec:** `docs/superpowers/specs/2026-07-01-monthly-salary-run-race-condition-design.md`

---

## File Structure

- **Create:** `server/repositories/monthlySalaryRunRepository.ts` — new repository, owns the atomic `acquireRun` operation.
- **Create:** `server/repositories/monthlySalaryRunRepository.real-db.test.ts` — real-database test proving the atomicity (concurrent calls, force, succeeded-skip).
- **Modify:** `server/services/monthlySalaryAutomation.ts` — delete the local `acquireRun` function, call the new repository instead, move the call inside the existing `try` block.
- **Modify:** `server/services/monthlySalaryAutomation.test.ts` — replace the `storage.getMonthlySalaryRun`/`storage.createMonthlySalaryRun` mocks with a mock of the new repository's `acquireRun`.

Out of scope for this plan (left for the storage-repository-split plan): moving `getMonthlySalaryRun`, `getRecentMonthlySalaryRuns`, `createMonthlySalaryRun`, `updateMonthlySalaryRun` out of `storage.ts`, and removing `getSalaryRecord*`/`*SalaryRecord*` from `storage.ts`.

---

### Task 1: Write the failing real-database test for atomic `acquireRun`

**Files:**
- Create: `server/repositories/monthlySalaryRunRepository.real-db.test.ts`

- [ ] **Step 1: Write the test file**

```typescript
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';

import { monthlySalaryRuns } from '@shared/schema';

let db: typeof import('../db').db;
let monthlySalaryRunRepository: typeof import('./monthlySalaryRunRepository').monthlySalaryRunRepository;

const TEST_YEAR = 2099;

beforeAll(() => {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required for monthlySalaryRunRepository real DB tests');
  }
});

beforeAll(async () => {
  ({ db } = await import('../db'));
  ({ monthlySalaryRunRepository } = await import('./monthlySalaryRunRepository'));
});

afterAll(async () => {
  await db.delete(monthlySalaryRuns).where(eq(monthlySalaryRuns.salaryYear, TEST_YEAR));
});

describe('monthlySalaryRunRepository.acquireRun (real database)', () => {
  it('creates a new running run when none exists', async () => {
    const result = await monthlySalaryRunRepository.acquireRun({
      year: TEST_YEAR,
      month: 1,
      runKey: `${TEST_YEAR}-01`,
      force: false,
      emailRecipients: ['payroll@example.com'],
    });

    expect(result.skipReason).toBeUndefined();
    expect(result.run).toBeDefined();
    expect(result.run?.status).toBe('running');
    expect(result.run?.salaryYear).toBe(TEST_YEAR);
    expect(result.run?.salaryMonth).toBe(1);
  });

  it('only lets one of two concurrent callers acquire the same month', async () => {
    const [first, second] = await Promise.all([
      monthlySalaryRunRepository.acquireRun({
        year: TEST_YEAR,
        month: 2,
        runKey: `${TEST_YEAR}-02`,
        force: false,
        emailRecipients: [],
      }),
      monthlySalaryRunRepository.acquireRun({
        year: TEST_YEAR,
        month: 2,
        runKey: `${TEST_YEAR}-02`,
        force: false,
        emailRecipients: [],
      }),
    ]);

    const results = [first, second];
    const acquired = results.filter((result) => !result.skipReason);
    const skipped = results.filter((result) => result.skipReason);

    expect(acquired).toHaveLength(1);
    expect(skipped).toHaveLength(1);
    expect(skipped[0].skipReason).toBe('monthly salary run is already running');

    const rows = await db
      .select()
      .from(monthlySalaryRuns)
      .where(and(eq(monthlySalaryRuns.salaryYear, TEST_YEAR), eq(monthlySalaryRuns.salaryMonth, 2)));

    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('running');
  });

  it('skips a succeeded run without force, and re-acquires with force', async () => {
    await monthlySalaryRunRepository.acquireRun({
      year: TEST_YEAR,
      month: 3,
      runKey: `${TEST_YEAR}-03`,
      force: false,
      emailRecipients: [],
    });

    await db
      .update(monthlySalaryRuns)
      .set({ status: 'succeeded' })
      .where(and(eq(monthlySalaryRuns.salaryYear, TEST_YEAR), eq(monthlySalaryRuns.salaryMonth, 3)));

    const withoutForce = await monthlySalaryRunRepository.acquireRun({
      year: TEST_YEAR,
      month: 3,
      runKey: `${TEST_YEAR}-03`,
      force: false,
      emailRecipients: [],
    });
    expect(withoutForce.skipReason).toBe('monthly salary run already succeeded');

    const withForce = await monthlySalaryRunRepository.acquireRun({
      year: TEST_YEAR,
      month: 3,
      runKey: `${TEST_YEAR}-03`,
      force: true,
      emailRecipients: [],
    });
    expect(withForce.skipReason).toBeUndefined();
    expect(withForce.run?.status).toBe('running');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

`npm run test:real-db` only chains two hardcoded files (`test:real-db:retention`, `test:real-db:rehearsal` — see `package.json`), so run this new file directly against the real-db Vitest config instead:

Run: `npx vitest run --config vitest.real-db.config.ts server/repositories/monthlySalaryRunRepository.real-db.test.ts`
Expected: FAIL — `Cannot find module './monthlySalaryRunRepository'` (the file doesn't exist yet).

---

### Task 2: Implement `monthlySalaryRunRepository.ts`

**Files:**
- Create: `server/repositories/monthlySalaryRunRepository.ts`

- [ ] **Step 1: Write the repository**

```typescript
import { and, eq, ne } from 'drizzle-orm';

import {
  monthlySalaryRuns,
  type InsertMonthlySalaryRun,
  type MonthlySalaryRun,
} from '@shared/schema';

import { db } from '../db';

export interface AcquireMonthlySalaryRunParams {
  year: number;
  month: number;
  runKey: string;
  force: boolean;
  emailRecipients: string[];
}

export interface AcquireMonthlySalaryRunResult {
  run?: MonthlySalaryRun;
  skipReason?: string;
}

export class DatabaseMonthlySalaryRunRepository {
  /**
   * Atomically creates the run row for (year, month) or, if one already exists,
   * updates it to `running` — unless it's already `running` or `succeeded` (and
   * `force` isn't set), in which case the row is left untouched and a
   * `skipReason` is returned. This is a single INSERT ... ON CONFLICT statement,
   * so two concurrent callers can never both acquire the same month.
   */
  async acquireRun(params: AcquireMonthlySalaryRunParams): Promise<AcquireMonthlySalaryRunResult> {
    const { year, month, runKey, force, emailRecipients } = params;

    const insertValues: InsertMonthlySalaryRun = {
      runKey,
      salaryYear: year,
      salaryMonth: month,
      status: 'running',
      recordCount: 0,
      skippedCount: 0,
      emailTo: emailRecipients,
    };

    const updateSet: Partial<MonthlySalaryRun> = {
      status: 'running',
      recordCount: 0,
      skippedCount: 0,
      pdfPath: null,
      emailTo: emailRecipients,
      emailSentAt: null,
      errorMessage: null,
      completedAt: null,
    };

    const rows = await db
      .insert(monthlySalaryRuns)
      .values(insertValues)
      .onConflictDoUpdate({
        target: [monthlySalaryRuns.salaryYear, monthlySalaryRuns.salaryMonth],
        set: updateSet,
        ...(force
          ? {}
          : {
              setWhere: and(
                ne(monthlySalaryRuns.status, 'running'),
                ne(monthlySalaryRuns.status, 'succeeded')
              )!,
            }),
      })
      .returning();

    const [run] = rows;

    if (run) {
      return { run };
    }

    const [existingRun] = await db
      .select()
      .from(monthlySalaryRuns)
      .where(and(eq(monthlySalaryRuns.salaryYear, year), eq(monthlySalaryRuns.salaryMonth, month)));

    return {
      run: existingRun,
      skipReason:
        existingRun?.status === 'succeeded'
          ? 'monthly salary run already succeeded'
          : 'monthly salary run is already running',
    };
  }
}

export const monthlySalaryRunRepository = new DatabaseMonthlySalaryRunRepository();
```

- [ ] **Step 2: Run the real-db test to verify it passes**

Run: `npx vitest run --config vitest.real-db.config.ts server/repositories/monthlySalaryRunRepository.real-db.test.ts`
Expected: PASS — all 3 tests green.

- [ ] **Step 3: Wire the new test into the `test:real-db` verification gate**

`package.json`'s `test:real-db` script (and README's "Extended database verification" section) only runs `test:real-db:retention` and `test:real-db:rehearsal` today. Add a third entry so this new test doesn't silently get skipped by anyone running the documented command.

In `package.json`, change:

```json
    "test:real-db": "npm run test:real-db:retention && npm run test:real-db:rehearsal",
    "test:real-db:retention": "vitest run --config vitest.real-db.config.ts server/storage.retention.real-db.test.ts",
    "test:real-db:rehearsal": "vitest run --config vitest.real-db.config.ts server/rehearsal.real-db.test.ts",
```

to:

```json
    "test:real-db": "npm run test:real-db:retention && npm run test:real-db:rehearsal && npm run test:real-db:monthly-salary-run",
    "test:real-db:retention": "vitest run --config vitest.real-db.config.ts server/storage.retention.real-db.test.ts",
    "test:real-db:rehearsal": "vitest run --config vitest.real-db.config.ts server/rehearsal.real-db.test.ts",
    "test:real-db:monthly-salary-run": "vitest run --config vitest.real-db.config.ts server/repositories/monthlySalaryRunRepository.real-db.test.ts",
```

- [ ] **Step 4: Run the full composite script to verify wiring**

Run: `npm run test:real-db`
Expected: PASS — all three real-db suites run and pass, in order.

- [ ] **Step 5: Commit**

```bash
git add server/repositories/monthlySalaryRunRepository.ts server/repositories/monthlySalaryRunRepository.real-db.test.ts package.json
git commit -m "feat: add atomic monthlySalaryRunRepository.acquireRun"
```

---

### Task 3: Update the existing unit test to expect the new repository collaborator

**Files:**
- Modify: `server/services/monthlySalaryAutomation.test.ts`

- [ ] **Step 1: Replace the `storageMock` block and add a repository mock**

In `server/services/monthlySalaryAutomation.test.ts`, replace the existing `storageMock` (currently lines 43-85) with this — it removes the now-unused `getMonthlySalaryRun`/`createMonthlySalaryRun` entries (the new repository owns those) and keeps everything else:

```typescript
const storageMock = vi.hoisted(() => ({
  updateMonthlySalaryRun: vi.fn(async (id: number, data: Record<string, any>) => {
    const run = state.salaryRuns.find((item) => item.id === id);
    if (!run) return undefined;
    Object.assign(run, data);
    return run;
  }),
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
  getSettings: vi.fn(async () => state.settings),
  getAllEmployees: vi.fn(async () => state.employees),
  getTemporaryAttendanceByEmployeeAndMonth: vi.fn(async (employeeId: number) =>
    state.attendance.filter((record) => record.employeeId === employeeId)
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
}));
```

- [ ] **Step 2: Register the new mock module**

Directly below the existing `vi.mock('../storage', ...)` line (currently line 101), add:

```typescript
vi.mock('../repositories/monthlySalaryRunRepository', () => ({
  monthlySalaryRunRepository: monthlySalaryRunRepositoryMock,
}));
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run server/services/monthlySalaryAutomation.test.ts`
Expected: FAIL on the "persists the monthly run..." test — `storage.getMonthlySalaryRun is not a function` (or similar), because `monthlySalaryAutomation.ts` still calls the old `storage` methods directly.

---

### Task 4: Refactor `monthlySalaryAutomation.ts` to use the new repository

**Files:**
- Modify: `server/services/monthlySalaryAutomation.ts:16` (imports), `:210-253` (delete local `acquireRun`), `:268-292` (`runMonthlySalaryAutomation` header + acquisition)

- [ ] **Step 1: Add the import**

Directly below the existing `import { storage } from '../storage';` line, add:

```typescript
import { monthlySalaryRunRepository } from '../repositories/monthlySalaryRunRepository';
```

- [ ] **Step 2: Delete the local `acquireRun` function**

Delete this whole function (currently lines 210-253):

```typescript
async function acquireRun(
  target: SalaryReportTarget,
  options: MonthlySalaryAutomationOptions,
  config: SalaryAutomationConfig
): Promise<{ run?: MonthlySalaryRun; skipReason?: string }> {
  if (options.dryRun) {
    return {};
  }

  const existingRun = await storage.getMonthlySalaryRun(target.year, target.month);
  if (existingRun?.status === 'succeeded' && !options.force) {
    return { run: existingRun, skipReason: 'monthly salary run already succeeded' };
  }

  if (existingRun?.status === 'running' && !options.force) {
    return { run: existingRun, skipReason: 'monthly salary run is already running' };
  }

  if (existingRun) {
    const updatedRun = await storage.updateMonthlySalaryRun(existingRun.id, {
      status: 'running',
      recordCount: 0,
      skippedCount: 0,
      pdfPath: null,
      emailTo: config.emailRecipients,
      emailSentAt: null,
      errorMessage: null,
      completedAt: null,
    });
    return { run: updatedRun ?? existingRun };
  }

  const run = await storage.createMonthlySalaryRun({
    runKey: getRunKey(target),
    salaryYear: target.year,
    salaryMonth: target.month,
    status: 'running',
    recordCount: 0,
    skippedCount: 0,
    emailTo: config.emailRecipients,
  });

  return { run };
}
```

(Leave `markRunFailed`, directly below it, untouched.)

- [ ] **Step 3: Replace the start of `runMonthlySalaryAutomation`**

Replace this block (currently lines 268-292):

```typescript
export async function runMonthlySalaryAutomation(
  options: MonthlySalaryAutomationOptions = {}
): Promise<MonthlySalaryAutomationResult> {
  const config = options.config ?? getSalaryAutomationConfig();
  const target = options.target ?? getPreviousSalaryMonthTarget(options.now, config.timeZone);
  const sendEmail = options.sendEmail ?? true;
  const calculatedRecords: InsertSalaryRecord[] = [];
  const persistedRecords: SalaryRecord[] = [];
  const skippedEmployees: MonthlySalaryAutomationResult['skippedEmployees'] = [];

  const { run, skipReason } = await acquireRun(target, options, config);
  if (skipReason) {
    return {
      target,
      status: 'skipped',
      reason: skipReason,
      run,
      calculatedRecords,
      persistedRecords: await storage.getSalaryRecordsByYearMonth(target.year, target.month),
      skippedEmployees,
      emailRecipients: run?.emailTo ?? [],
    };
  }

  try {
    const settings = await storage.getSettings();
```

with:

```typescript
export async function runMonthlySalaryAutomation(
  options: MonthlySalaryAutomationOptions = {}
): Promise<MonthlySalaryAutomationResult> {
  const config = options.config ?? getSalaryAutomationConfig();
  const target = options.target ?? getPreviousSalaryMonthTarget(options.now, config.timeZone);
  const sendEmail = options.sendEmail ?? true;
  const calculatedRecords: InsertSalaryRecord[] = [];
  const persistedRecords: SalaryRecord[] = [];
  const skippedEmployees: MonthlySalaryAutomationResult['skippedEmployees'] = [];

  let run: MonthlySalaryRun | undefined;

  try {
    if (!options.dryRun) {
      const acquireResult = await monthlySalaryRunRepository.acquireRun({
        year: target.year,
        month: target.month,
        runKey: getRunKey(target),
        force: !!options.force,
        emailRecipients: config.emailRecipients,
      });
      run = acquireResult.run;

      if (acquireResult.skipReason) {
        return {
          target,
          status: 'skipped',
          reason: acquireResult.skipReason,
          run,
          calculatedRecords,
          persistedRecords: await storage.getSalaryRecordsByYearMonth(target.year, target.month),
          skippedEmployees,
          emailRecipients: run?.emailTo ?? [],
        };
      }
    }

    const settings = await storage.getSettings();
```

Everything from `const settings = await storage.getSettings();` onward (the rest of the `try` block and the `catch` block) stays exactly as it is today — no further edits needed there. The acquisition call and its skip-return now live inside the same `try`, so any error it throws is caught by the existing `catch (error) { const failedRun = await markRunFailed(run, error); ... }` below.

- [ ] **Step 4: Run the unit test to verify it passes**

Run: `npx vitest run server/services/monthlySalaryAutomation.test.ts`
Expected: PASS — all tests green, including "persists the monthly run, PDF path, and sent email metadata".

- [ ] **Step 5: Run the real-database test suite once more**

Run: `npm run test:real-db`
Expected: PASS (unchanged from Task 2, confirms nothing in this task broke the repository itself).

- [ ] **Step 6: Commit**

```bash
git add server/services/monthlySalaryAutomation.ts server/services/monthlySalaryAutomation.test.ts
git commit -m "fix: acquire monthly salary run atomically, inside try/catch"
```

---

### Task 5: Full regression check

**Files:** none (verification only)

- [ ] **Step 1: Run the full non-real-db suite**

Run: `npx vitest run`
Expected: PASS — no unrelated test broken by the import change.

- [ ] **Step 2: Run the smoke suite**

Run: `npm run test:smoke` (per `vitest.smoke.config.ts`)
Expected: PASS.

- [ ] **Step 3: Manually sanity-check the automation route**

Confirm `server/routes/salaryAutomation.routes.ts` (`POST /api/salary-automation/run`) still compiles and its call to `runMonthlySalaryAutomation(...)` needs no changes — the function's public signature (`MonthlySalaryAutomationOptions` in, `MonthlySalaryAutomationResult` out) is unchanged by this plan. No file edit expected here; this step is a read-only check.

---

## Self-Review Notes

- **Spec coverage:** All 4 elements of the approved design (atomic `acquireRun`, moved inside `try`, error handling via existing `markRunFailed`, concurrency test) map to Task 1/2 (repository + test) and Task 3/4 (consumer migration + existing test updated). ✅
- **Placeholder scan:** No TBD/TODO; every step has full code. ✅
- **Type consistency:** `AcquireMonthlySalaryRunParams`/`AcquireMonthlySalaryRunResult` (Task 2) match the shape used by the mock in Task 3 and the call site in Task 4 (`year`, `month`, `runKey`, `force`, `emailRecipients` throughout). `monthlySalaryRunRepository.acquireRun` name matches in all three places. ✅
- **Dry-run behavior preserved:** original code short-circuited before ever touching `monthly_salary_runs` when `options.dryRun` was true; Task 4's replacement keeps that by gating the whole acquisition block on `if (!options.dryRun)`. ✅
