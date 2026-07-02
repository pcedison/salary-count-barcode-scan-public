# Design: Monthly Salary Run Race Condition Fix

- Date: 2026-07-01
- Status: Approved
- Priority: 1 of 3 (execute first — smallest blast radius, highest reliability risk)
- Related: docs/CODE_AUDIT_REPORT_2026-07-01.md (可靠度 section, High severity items)

## Problem

`server/services/monthlySalaryAutomation.ts:210-253` (`acquireRun`) reads the existing `monthly_salary_runs` row, inspects `status`, then either creates or updates it — three separate DB round-trips with no atomicity. The manual trigger endpoint (`POST /api/salary-automation/run`) and the scheduler tick (`server/runtime/monthly-salary-scheduler.ts`) can call this concurrently.

Additionally, the `acquireRun` call (`monthlySalaryAutomation.ts:278`) sits *outside* the `try` block that starts at line 292. If a race does produce a unique-constraint violation on `(salaryYear, salaryMonth)`, that exception propagates unhandled instead of being caught by `markRunFailed`.

Deployment is confirmed single-process (single Zeabur service instance) for now, but the fix should not rely on that assumption holding forever.

## Approach

Replace the read-then-write logic with a single atomic UPSERT using Drizzle's `onConflictDoUpdate`, keyed on the existing `(salaryYear, salaryMonth)` unique constraint (`shared/schema.ts:170`, `monthly_salary_runs_year_month_uniq`). No schema change needed.

Rejected alternatives:
- `SELECT ... FOR UPDATE` in a transaction — needs an extra "insert if missing" step before the lock is meaningful; more code for the same outcome.
- `pg_advisory_xact_lock` (the pattern already used in `upsertTemporaryAttendanceScan`) — a good pattern in general, but heavier than necessary for a single UPSERT decision.

## Design

### Components

**New**: `monthlySalaryRunRepository.acquireRun(target, config, force)` (lives in the new `server/repositories/monthlySalaryRunRepository.ts` — see the storage-repository-split design doc, this method is created as part of that same file).

Behavior:
1. `INSERT INTO monthly_salary_runs (runKey, salaryYear, salaryMonth, status='running', ...) ON CONFLICT (salaryYear, salaryMonth) DO UPDATE SET status='running', recordCount=0, skippedCount=0, pdfPath=NULL, emailTo=$emailTo, emailSentAt=NULL, errorMessage=NULL, completedAt=NULL WHERE force OR (status != 'running' AND status != 'succeeded') RETURNING *`
2. If a row is returned → run acquired, proceed.
3. If no row is returned → the WHERE condition was false (existing run is `running` or `succeeded` and `force` is not set). Re-fetch the existing run via a plain `SELECT` to build the `skipReason` message (`'monthly salary run is already running'` or `'monthly salary run already succeeded'`), matching current message text so callers/tests relying on those strings keep working.

**Changed**: `server/services/monthlySalaryAutomation.ts`
- `acquireRun()` (the service-level function) becomes a thin call into `monthlySalaryRunRepository.acquireRun(...)`.
- The call site at what is currently line 278 moves inside the `try` block (i.e., becomes the first statement after `try {`), so any error it raises is caught by the existing `catch (error) { markRunFailed(run, error); ... }` block. Since `run` is `undefined` at that point on failure, `markRunFailed` already handles `run === undefined` by returning `undefined` (see line 255-258) — no change needed there.

### Data flow

`POST /api/salary-automation/run` or scheduler tick → `runMonthlySalaryAutomation()` → `try { acquireRun() ... }` → `monthlySalaryRunRepository.acquireRun()` → single atomic SQL statement → `{ run, skipReason }` → rest of function unchanged.

### Error handling

- The atomic UPSERT removes the unique-violation race entirely for the concurrent-call scenario (the WHERE clause turns the second caller's attempt into a no-op instead of a constraint violation).
- Moving the call inside `try` is defense-in-depth for any other error during acquisition (e.g., a transient DB error), ensuring it's always reflected as a `failed` run rather than an unhandled rejection.

### Testing

Add a test (in `monthlySalaryAutomation.test.ts` if it can run against a real/test DB, otherwise a new case in the real-db suite) that:
1. Fires two concurrent `acquireRun` calls (`Promise.all`) for the same target month.
2. Asserts exactly one call returns a `run` with `status: 'running'` and the other returns `skipReason` matching the "already running" message.
3. Asserts the database ends up with exactly one row for that `(salaryYear, salaryMonth)`.

Existing tests that assert on `acquireRun` skip-reason message text must continue to pass unchanged (message text is preserved by design).

## Out of scope

- Multi-instance/distributed locking beyond what the DB-level UPSERT already provides — not needed for the current single-process deployment; revisit if deployment topology changes.
- Retry logic for LINE API calls (flagged separately in the audit, not part of this fix).
- The per-employee loop not being wrapped in a transaction (flagged in the audit as a separate Medium-severity issue; not addressed here to keep this change focused on the acquisition race).
