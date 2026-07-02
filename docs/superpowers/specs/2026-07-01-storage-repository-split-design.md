# Design: Split `storage.ts` — Salary Records & Monthly Salary Run Repositories

- Date: 2026-07-01
- Status: Approved
- Priority: 2 of 3 (execute after the race-condition fix, since the new `monthlySalaryRunRepository.acquireRun` created there lands in this repository)
- Related: docs/CODE_AUDIT_REPORT_2026-07-01.md (模組化/可重構性 section)

## Problem

`server/storage.ts` (1053 lines) is a single `DatabaseStorage` class implementing `IStorage` for every domain (employees, attendance, settings, salary records, monthly salary runs, holidays, LINE bindings, OAuth states, calculation rules, Taiwan holidays). The one domain that has been partially extracted, `employeeRepository.ts`, is only ever called from inside `storage.ts` — route handlers still call `storage.xxx()` for everything, so the "layering" is cosmetic: a new contributor looking at `routes/` has no way to discover the repository pattern exists.

This round scopes the split to **salary records** and **monthly salary run** only (not the other domains — that's future work), because:
- It's the domain the race-condition fix (priority 1) already touches.
- It's a bounded, well-tested slice: 9 files touch these methods (a first pass found 7 by grepping the obvious method names; `employee-retention.ts` and its test surfaced during detailed inventory since `purgeExpiredRetainedSalaryRecords` didn't match that initial pattern).

## Approach

**Chosen: full migration.** Move the methods out of `IStorage`/`DatabaseStorage` entirely (not just add a delegating wrapper) and update every call site to import the new repository directly. This is what actually fixes the problem described above — a wrapper-only approach (new repository files that `storage.ts` delegates to, call sites unchanged) would repeat the same mistake already made with `employeeRepository.ts`.

## Design

### New files

- `server/repositories/salaryRepository.ts`
- `server/repositories/monthlySalaryRunRepository.ts` (includes the atomic `acquireRun` from the race-condition-fix design doc)

Both follow the existing `employeeRepository.ts` style: a plain object/class exporting the methods, using the shared `db` instance from `server/db.ts`, no dependency on `storage.ts`.

### Methods moved

**`salaryRepository`** (from `IStorage`/`DatabaseStorage` in `server/storage.ts`):
- `getAllSalaryRecords()`
- `getAllSalaryRecordsPage(page, limit, filters?)`
- `getSalaryRecordYears(filters?)`
- `getSalaryRecordById(id)`
- `getSalaryRecordByYearMonth(year, month)`
- `getSalaryRecordsByYearMonth(year, month)`
- `getSalaryRecordByYearMonthEmployee(year, month, employeeId)`
- `createSalaryRecord(record)`
- `updateSalaryRecord(id, record)`
- `deleteSalaryRecord(id)`
- `purgeExpiredRetainedSalaryRecords()` — currently at `storage.ts:348-...`; operates directly on the `salaryRecords` table for retention cleanup, same domain as the rest of this list. (Not moving `purgeEmployee` / `purgeExpiredDeletedEmployees` — those already delegate to `employeeRepository` and are employee-domain-owned, out of scope here even though they touch salary records as an anonymization side effect.)
- `buildSalaryRecordPageWhere(...)` — currently a module-private helper function (`storage.ts:167`), moves as a private helper inside the new file.

**`monthlySalaryRunRepository`**:
- `getMonthlySalaryRun(year, month)`
- `getRecentMonthlySalaryRuns(limit?)`
- `createMonthlySalaryRun(run)`
- `updateMonthlySalaryRun(id, run)`
- `acquireRun(target, config, force)` — new, from the race-condition-fix design doc

### Call sites to update (9 files)

| File | Change |
|---|---|
| `server/services/monthlySalaryAutomation.ts` | Import both repositories; replace all `storage.getSalaryRecord*` / `storage.*SalaryRecord` / `storage.*MonthlySalaryRun` calls |
| `server/routes/salary.routes.ts` | Import `salaryRepository`; replace all `storage.*SalaryRecord*` calls |
| `server/routes/salaryAutomation.routes.ts` | Import `monthlySalaryRunRepository`; replace `storage.getRecentMonthlySalaryRuns` |
| `server/routes/import.routes.ts` | Import `salaryRepository`; replace `storage.getSalaryRecordByYearMonthEmployee`, `storage.getSalaryRecordsByYearMonth`, `storage.updateSalaryRecord`, `storage.createSalaryRecord` |
| `server/db-monitoring.ts` | Import `salaryRepository`; replace `storage.getAllSalaryRecords` (2 call sites, backup/restore paths) |
| `server/employee-retention.ts` | Import `salaryRepository`; replace `storage.purgeExpiredRetainedSalaryRecords` |
| `server/storage.real-db.test.ts` | Update to call `salaryRepository`/`monthlySalaryRunRepository` directly instead of `storage.*` |
| `server/storage.retention.real-db.test.ts` | Same |
| `server/employee-retention.test.ts` | Mocks `storage.purgeExpiredRetainedSalaryRecords` via `vi.fn()` — update the mock target to `salaryRepository` |

### `IStorage` interface change

Remove the salary-record and monthly-salary-run method signatures from `IStorage` (`storage.ts:235-253`) and their implementations from `DatabaseStorage`. `DatabaseStorage` no longer touches the `salaryRecords` or `monthlySalaryRuns` tables at all after this change.

### Data flow

Before: `route handler → storage.xxx() → DatabaseStorage method → db query`
After: `route handler → salaryRepository.xxx() / monthlySalaryRunRepository.xxx() → db query` (one fewer indirection layer, and the layer that remains is domain-named instead of a generic facade)

### Error handling

Pure move — no behavior change. Existing error handling (try/catch at call sites, transaction usage) is preserved as-is; none of the moved methods currently use `db.transaction()`, so none is introduced here either.

### Testing

- Existing tests (`monthlySalaryAutomation.test.ts`, `e2e-salary-flow.integration.test.ts`, `salary.routes.test.ts`/`salary.routes.integration.test.ts`, `storage.real-db.test.ts`, `storage.retention.real-db.test.ts`, `employee-retention.test.ts`) act as the regression safety net — after updating imports/mocks, all assertions should pass unchanged since this is a pure relocation.
- Add direct unit/integration tests for `salaryRepository` and `monthlySalaryRunRepository` if the moved methods don't already have direct (non-route-level) coverage.
- Run `npm run test:real-db` after the move, since several affected call sites (`db-monitoring.ts`, retention paths) are only meaningfully exercised against a real database.

## Out of scope

- Splitting `employees`, `attendance`, `holidays`, `line`, or `settings` domains out of `storage.ts` — future rounds, one domain at a time, same pattern.
- Refactoring `server/routes/scan.routes.ts`'s inline HMAC/cache logic (flagged separately in the audit).
- Any behavior change to salary calculation logic itself.
