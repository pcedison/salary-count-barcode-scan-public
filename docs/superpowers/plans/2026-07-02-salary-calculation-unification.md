# Salary Calculation Unification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `shared/utils/salaryMath.ts` + `shared/calculationModel.ts` the only implementation of salary math — the server and client modules become thin, type-safe delegation layers with zero copied formulas and zero duplicated interface declarations.

**Architecture:** Research confirmed the three "copies" already mostly delegate to `shared/utils/salaryMath.ts`. The remaining duplication is: (a) `standardCalculationLogic` in `shared/calculationModel.ts` re-implements the same math inline, (b) `server/utils/salaryCalculator.ts` re-declares every interface and carries six functions with no production callers, (c) `client/src/lib/salaryCalculations.ts` re-declares the same interfaces and exports five functions used only by its own test. The fix: first pin behavior with a cross-module parity (characterization) test, then delete the inline copies and dead surface, re-exporting canonical types from `shared/`.

**Tech Stack:** TypeScript, Vitest (`vitest.config.ts`, aliases `@` → `client/src`, `@shared` → `shared`), no runtime dependency changes.

**Verified usage map (2026-07-02):**
- `server/routes/salary.routes.ts` uses from `salaryCalculator`: `calculateSalary`, `calculateHolidayPayAdjustments`, `calculateOvertimePay`, `type OvertimeHours` (via dynamic `import('../utils/salaryCalculator')` at line 81).
- `server/routes/salary-helpers.ts` uses `type CalculationSettings`.
- Client production imports from `salaryCalculations`: only `calculateOvertime` (3 files) and `calculateDailyOvertimePay` (2 files).
- Dead in `salaryCalculator.ts` (no callers outside the file/test): `loadSpecialRulesFromDB`, `saveSpecialRuleToDB` (superseded by `server/services/calculationRulesLoader.ts`), `convertAttendanceToDaily`, `calculateSalaryByDaily`, `validateSalaryRecord`, `validateSalaryRecordByDaily`, `calculateGrossSalary`, `calculateNetSalary`, `calculateOvertime`, interfaces `SpecialCaseCondition`/`SpecialCaseRule`/`CalculationModel`.
- Dead in `salaryCalculations.ts` (test-only): `calculateSalary`, `validateSalaryRecord`, `calculateOvertimePay`, `calculateGrossSalary`, `calculateNetSalary`, `calculateSimpleOvertime`, all local interfaces.
- `standardCalculationLogic` is referenced only inside `shared/calculationModel.ts` itself.

---

## File Structure

- **Create:** `server/utils/salaryCalculation.parity.test.ts` — cross-module characterization test (client vs server vs shared).
- **Modify:** `shared/calculationModel.ts` — delete `standardCalculationLogic`, wire the model to `salaryMath` functions directly, drop `DailyOvertimeRecord` if unused after server slimming.
- **Modify (rewrite):** `server/utils/salaryCalculator.ts` — keep only the three functions salary.routes uses plus `calculateHolidayPayAdjustments`; re-export canonical types from shared.
- **Modify (rewrite):** `client/src/lib/salaryCalculations.ts` — keep only the two production wrappers.
- **Modify (rewrite):** `client/src/lib/salaryCalculations.test.ts` — cover the remaining wrappers with parity-vs-shared assertions.
- **Untouched:** `shared/utils/salaryMath.ts` (already the single math core, fully tested in `salaryMath.test.ts`), `server/utils/salaryCalculator.test.ts` (tests `calculateHolidayPayAdjustments`, which survives).

Out of scope: `client/src/lib/utils.ts`'s `calculateOvertime` wrapper (already a one-line delegate to salaryMath — no copied formula), `useAttendanceData.ts`'s local `calculateSalary` closure (UI orchestration, not formula duplication), and moving `calculateHolidayPayAdjustments` to `shared/` (server-only business logic; client never renders those adjustments locally).

---

### Task 1: Pin current behavior with a cross-module parity test

**Files:**
- Create: `server/utils/salaryCalculation.parity.test.ts`

This is a characterization test: it must PASS against the current code before any refactoring, and keep passing unchanged through every later task. It asserts client wrapper ≡ server wrapper ≡ shared implementation over a grid of inputs.

- [ ] **Step 1: Write the parity test**

```typescript
import { describe, expect, it } from 'vitest';

import {
  calculateDailyOvertimePay as clientCalculateDailyOvertimePay,
  calculateOvertime as clientCalculateOvertime,
} from '@/lib/salaryCalculations';
import {
  calculateOvertime as sharedCalculateOvertime,
  calculateOvertimePay as sharedCalculateOvertimePay,
  calculateDailyOvertimePay as sharedCalculateDailyOvertimePay,
} from '@shared/utils/salaryMath';
import { calculateSalary as sharedCalculateSalary } from '@shared/calculationModel';
import { constants } from '@shared/constants';

import {
  calculateOvertimePay as serverCalculateOvertimePay,
  calculateSalary as serverCalculateSalary,
} from './salaryCalculator';

const CLOCK_PAIRS: Array<[string, string]> = [
  ['08:00', '16:00'], // no overtime
  ['07:45', '16:09'], // early arrival, below OT1 threshold
  ['08:00', '16:10'], // exactly 0.5h OT1
  ['08:00', '17:10'], // 1h OT1
  ['08:05', '18:10'], // 2h OT1 cap
  ['08:00', '19:45'], // OT1 + OT2
  ['08:00', '21:00'], // deep OT2
];

const SETTINGS_VARIANTS = [
  {
    baseHourlyRate: constants.BASE_HOURLY_RATE,
    ot1Multiplier: constants.OT1_MULTIPLIER,
    ot2Multiplier: constants.OT2_MULTIPLIER,
    baseMonthSalary: 30000,
  },
  {
    baseHourlyRate: 150,
    ot1Multiplier: 1.5,
    ot2Multiplier: 2.0,
    baseMonthSalary: 36000,
    welfareAllowance: 800,
  },
];

const OVERTIME_GRIDS = [
  { totalOT1Hours: 0, totalOT2Hours: 0 },
  { totalOT1Hours: 0.5, totalOT2Hours: 0 },
  { totalOT1Hours: 2, totalOT2Hours: 0 },
  { totalOT1Hours: 2, totalOT2Hours: 1.5 },
  { totalOT1Hours: 14.5, totalOT2Hours: 6 },
];

describe('salary calculation parity (client ≡ server ≡ shared)', () => {
  it('client and shared agree on overtime hour breakdown for every clock pair', () => {
    for (const [clockIn, clockOut] of CLOCK_PAIRS) {
      const shared = sharedCalculateOvertime(clockIn, clockOut);
      const client = clientCalculateOvertime(clockIn, clockOut);

      expect(client, `${clockIn}-${clockOut}`).toEqual({ ot1: shared.ot1, ot2: shared.ot2 });
    }
  });

  it('client daily overtime pay equals shared implementation with derived hourly rate', () => {
    const baseSalary = 30000;
    const hourlyRate =
      baseSalary / constants.STANDARD_WORK_DAYS / constants.STANDARD_WORK_HOURS;

    for (const [clockIn, clockOut] of CLOCK_PAIRS) {
      const expected = sharedCalculateDailyOvertimePay(clockIn, clockOut, {
        baseHourlyRate: hourlyRate,
        ot1Multiplier: constants.OT1_MULTIPLIER,
        ot2Multiplier: constants.OT2_MULTIPLIER,
      });

      expect(
        clientCalculateDailyOvertimePay(clockIn, clockOut, baseSalary),
        `${clockIn}-${clockOut}`,
      ).toBe(expected);
    }
  });

  it('server overtime pay equals shared implementation for every settings/hours combo', () => {
    for (const settings of SETTINGS_VARIANTS) {
      for (const hours of OVERTIME_GRIDS) {
        expect(
          serverCalculateOvertimePay(hours, settings),
          JSON.stringify({ settings, hours }),
        ).toBe(sharedCalculateOvertimePay(hours, settings));
      }
    }
  });

  it('server calculateSalary equals shared calculateSalary end-to-end', () => {
    for (const settings of SETTINGS_VARIANTS) {
      for (const hours of OVERTIME_GRIDS) {
        const serverResult = serverCalculateSalary(
          2026, 5, hours, settings.baseMonthSalary, 1200, settings, 1000, 500, 0, 42,
        );
        const sharedResult = sharedCalculateSalary(
          2026, 5, 42, hours, settings.baseMonthSalary, 1200, settings, 1000, 500, 0,
        );

        expect(serverResult, JSON.stringify({ settings, hours })).toEqual(sharedResult);
      }
    }
  });
});
```

- [ ] **Step 2: Run it — must PASS against current, unrefactored code**

Run: `npx vitest run server/utils/salaryCalculation.parity.test.ts`
Expected: PASS (4 tests). If any assertion fails, STOP — that is a live behavioral divergence between the copies; report it instead of refactoring over it.

- [ ] **Step 3: Commit**

```bash
git add server/utils/salaryCalculation.parity.test.ts
git commit -m "test: pin salary calculation parity across client/server/shared"
```

---

### Task 2: Remove the inline math copy in `shared/calculationModel.ts`

**Files:**
- Modify: `shared/calculationModel.ts:106-189` (delete `DailyOvertimeRecord` + `standardCalculationLogic`), `:194-205` (rewire model)

- [ ] **Step 1: Verify `standardCalculationLogic` and `DailyOvertimeRecord` have no external consumers left**

Run: `grep -rn "standardCalculationLogic" server client shared --include="*.ts" --include="*.tsx" | grep -v "shared/calculationModel.ts"`
Expected: no output.

Run: `grep -rn "DailyOvertimeRecord" server client shared --include="*.ts" --include="*.tsx" | grep -v "shared/calculationModel.ts"`
Expected: hits only in `server/utils/salaryCalculator.ts` (which Task 3 deletes). If any other file appears, keep the interface and adjust Task 3 accordingly.

- [ ] **Step 2: Delete the `DailyOvertimeRecord` interface and the whole `standardCalculationLogic` object**

Delete lines 106-189 (from `/** 單日加班記錄界面 */` through the closing `};` of `standardCalculationLogic`). Keep `DailyOvertimeRecord` only if Step 1 found other consumers.

- [ ] **Step 3: Rewire `standardCalculationModel` to the salaryMath functions**

Change:

```typescript
  calculateOvertimePay: standardCalculationLogic.calculateOvertimePay,
  calculateGrossSalary: standardCalculationLogic.calculateGrossSalary,
  calculateNetSalary: standardCalculationLogic.calculateNetSalary,
```

to:

```typescript
  calculateOvertimePay: (overtimeHours, settings) => sharedCalculateOvertimePay(overtimeHours, settings),
  calculateGrossSalary: sharedCalculateGrossSalary,
  calculateNetSalary: sharedCalculateNetSalary,
```

(`sharedCalculateOvertimePay`, `sharedCalculateGrossSalary`, `sharedCalculateNetSalary` are already imported at the top of the file. The arrow wrapper on `calculateOvertimePay` narrows salaryMath's `Partial<SalaryMathSettings>` parameter to the model interface's `CalculationSettings`.)

- [ ] **Step 4: Typecheck + run the pinning tests**

Run: `npm run check && npx vitest run server/utils/salaryCalculation.parity.test.ts shared/utils/salaryMath.test.ts client/src/lib/salaryCalculations.test.ts server/utils/salaryCalculator.test.ts`
Expected: PASS — identical math, so no behavioral change.

- [ ] **Step 5: Commit**

```bash
git add shared/calculationModel.ts
git commit -m "refactor: calculationModel delegates to salaryMath, drop inline math copy"
```

---

### Task 3: Slim `server/utils/salaryCalculator.ts` to its production surface

**Files:**
- Modify (rewrite): `server/utils/salaryCalculator.ts`

- [ ] **Step 1: Verify the dead functions really have no callers**

Run: `grep -rn "loadSpecialRulesFromDB\|saveSpecialRuleToDB\|convertAttendanceToDaily\|calculateSalaryByDaily\|validateSalaryRecordByDaily" server client shared scripts --include="*.ts" --include="*.tsx" --include="*.mjs" | grep -v "server/utils/salaryCalculator"`
Expected: no output. If anything appears, keep that function and note it in the commit message.

Run: `grep -rn "from '../utils/salaryCalculator'\|utils/salaryCalculator')" server --include="*.ts" | grep -v test`
Expected: only `salary-helpers.ts` (type import) and `salary.routes.ts` (type import + dynamic import).

- [ ] **Step 2: Replace the whole file with the slimmed version**

```typescript
/**
 * 伺服器端薪資計算模組
 *
 * 純委派層：所有共用薪資數學都在 shared/utils/salaryMath.ts 與
 * shared/calculationModel.ts，此檔只保留 salary.routes.ts 實際使用的
 * 介面，加上伺服器獨有的假日薪資調整邏輯（台灣勞基法）。
 */

import { calculateSalary as sharedCalculateSalary } from '../../shared/calculationModel';
import { calculateOvertimePay as sharedCalculateOvertimePay } from '../../shared/utils/salaryMath';

import type {
  CalculationSettings,
  OvertimeHours,
  SalaryCalculationResult,
} from '../../shared/calculationModel';

export type {
  CalculationSettings,
  OvertimeHours,
  SalaryCalculationResult,
} from '../../shared/calculationModel';

/**
 * 標準加班費計算函數 - 委派給共享實作
 */
export function calculateOvertimePay(
  overtimeHours: OvertimeHours,
  settings: CalculationSettings
): number {
  return sharedCalculateOvertimePay(overtimeHours, settings);
}

/**
 * 統一薪資計算函數 - 委派給共享計算模型
 */
export function calculateSalary(
  year: number,
  month: number,
  rawOvertimeHours: OvertimeHours,
  baseSalary: number,
  totalDeductions: number,
  settings: CalculationSettings,
  holidayPay: number = 0,
  welfareAllowance?: number,
  housingAllowance: number = 0,
  employeeId: number = 0
): SalaryCalculationResult {
  return sharedCalculateSalary(
    year,
    month,
    employeeId,
    rawOvertimeHours,
    baseSalary,
    totalDeductions,
    settings,
    holidayPay,
    welfareAllowance,
    housingAllowance
  );
}
```

…then append the existing `calculateHolidayPayAdjustments` function (lines 266-437 of the current file) **verbatim, unchanged** — it is server-only business logic with its own unit tests, not a duplicate of shared math.

- [ ] **Step 3: Typecheck + run the affected suites**

Run: `npm run check && npx vitest run server/utils server/routes/salary.routes.integration.test.ts server/routes/e2e-salary-flow.integration.test.ts`
Expected: PASS. (The integration tests `vi.mock` this module wholesale, so removing dead exports cannot break them; the parity test from Task 1 guards the surviving delegations.)

- [ ] **Step 4: Commit**

```bash
git add server/utils/salaryCalculator.ts
git commit -m "refactor: slim salaryCalculator to production surface, re-export shared types"
```

---

### Task 4: Slim `client/src/lib/salaryCalculations.ts` to its production surface

**Files:**
- Modify (rewrite): `client/src/lib/salaryCalculations.ts`
- Modify (rewrite): `client/src/lib/salaryCalculations.test.ts`

- [ ] **Step 1: Re-verify the client production import surface**

Run: `grep -rn "from '@/lib/salaryCalculations'" client/src --include="*.ts" --include="*.tsx" | grep -v test`
Expected: only `calculateOvertime` and `calculateDailyOvertimePay` are imported (PrintableSalarySheet.tsx, useHistoryData.ts, PrintSalaryPage.tsx). If anything else appears, keep that export.

- [ ] **Step 2: Replace the module with the slimmed version**

```typescript
/**
 * 前端薪資計算模塊
 *
 * 純委派層：所有共用薪資數學都在 shared/utils/salaryMath.ts。
 * 此檔只保留前端頁面實際使用的兩個便利包裝。
 */

import { constants } from './constants';

import {
  calculateDailyOvertimePay as sharedCalculateDailyOvertimePay,
  calculateOvertime as sharedCalculateOvertime,
} from '@shared/utils/salaryMath';

/**
 * 計算打卡之間的加班時數（回傳 { ot1, ot2 }，捨棄總工時欄位）
 */
export function calculateOvertime(clockIn: string, clockOut: string): { ot1: number; ot2: number } {
  const overtime = sharedCalculateOvertime(clockIn, clockOut);
  return { ot1: overtime.ot1, ot2: overtime.ot2 };
}

/**
 * 計算單日加班費用 — 由基本月薪推導時薪後委派共享實作
 */
export function calculateDailyOvertimePay(clockIn: string, clockOut: string, baseSalary: number): number {
  const hourlyRate = baseSalary / constants.STANDARD_WORK_DAYS / constants.STANDARD_WORK_HOURS;
  return sharedCalculateDailyOvertimePay(clockIn, clockOut, {
    baseHourlyRate: hourlyRate,
    ot1Multiplier: constants.OT1_MULTIPLIER,
    ot2Multiplier: constants.OT2_MULTIPLIER,
  });
}
```

- [ ] **Step 3: Rewrite the test to cover the surviving wrappers**

Replace `client/src/lib/salaryCalculations.test.ts` with:

```typescript
import { describe, expect, it } from 'vitest';

import { constants } from './constants';
import { calculateDailyOvertimePay, calculateOvertime } from './salaryCalculations';
import {
  calculateDailyOvertimePay as sharedCalculateDailyOvertimePay,
  calculateOvertime as sharedCalculateOvertime,
} from '@shared/utils/salaryMath';

describe('salaryCalculations', () => {
  it('calculateOvertime mirrors the shared breakdown without the total field', () => {
    const cases: Array<[string, string]> = [
      ['08:00', '16:00'],
      ['08:00', '16:10'],
      ['08:00', '17:10'],
      ['08:00', '18:10'],
      ['08:00', '19:45'],
    ];

    for (const [clockIn, clockOut] of cases) {
      const shared = sharedCalculateOvertime(clockIn, clockOut);
      expect(calculateOvertime(clockIn, clockOut), `${clockIn}-${clockOut}`).toEqual({
        ot1: shared.ot1,
        ot2: shared.ot2,
      });
    }
  });

  it('calculateDailyOvertimePay derives the hourly rate from the monthly base salary', () => {
    const baseSalary = 30000;
    const hourlyRate =
      baseSalary / constants.STANDARD_WORK_DAYS / constants.STANDARD_WORK_HOURS;

    const expected = sharedCalculateDailyOvertimePay('08:00', '19:45', {
      baseHourlyRate: hourlyRate,
      ot1Multiplier: constants.OT1_MULTIPLIER,
      ot2Multiplier: constants.OT2_MULTIPLIER,
    });

    expect(calculateDailyOvertimePay('08:00', '19:45', baseSalary)).toBe(expected);
  });

  it('returns zero pay for a day with no overtime', () => {
    expect(calculateDailyOvertimePay('08:00', '16:00', 30000)).toBe(0);
  });
});
```

- [ ] **Step 4: Typecheck + run client and parity suites**

Run: `npm run check && npx vitest run client/src/lib/salaryCalculations.test.ts server/utils/salaryCalculation.parity.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add client/src/lib/salaryCalculations.ts client/src/lib/salaryCalculations.test.ts
git commit -m "refactor: slim client salaryCalculations to production surface"
```

---

### Task 5: Full regression + duplication re-measurement

**Files:** none (verification only)

- [ ] **Step 1: Full CI gate**

Run: `npm run verify:ci`
Expected: PASS (tsc + full vitest + production build + runtime-bundle check).

- [ ] **Step 2: Confirm the salary clones are gone**

Run: `npx --yes jscpd server client/src shared --min-tokens 60 --reporters console --ignore "**/*.test.ts,**/*.test.tsx,**/components/ui/**" 2>&1 | grep -i "salaryCalculator\|salaryCalculations\|calculationModel"`
Expected: no output (previously 7 clone pairs involved these files).

- [ ] **Step 3: Run the smoke suite**

Run: `npm run test:smoke`
Expected: PASS.

---

## Self-Review Notes

- **Spec coverage:** characterization-first (Task 1), all three copies unified (Tasks 2-4), regression + measurable duplication drop (Task 5). ✅
- **Placeholder scan:** every step has full code or an exact command with expected output; the only "verbatim carry-over" is `calculateHolidayPayAdjustments`, explicitly bounded by current line numbers. ✅
- **Type consistency:** canonical types live in `shared/calculationModel.ts`; server re-exports them so `salary-helpers.ts`/`salary.routes.ts` type imports keep compiling unchanged; client wrappers need no interface at all. Parity test imports match each module's surviving surface (client: 2 fns; server: `calculateOvertimePay`/`calculateSalary`). ✅
- **Failure mode:** if Task 1 fails, the plan mandates stopping — a parity failure means the copies have already drifted and the divergence must be reported before unification.
