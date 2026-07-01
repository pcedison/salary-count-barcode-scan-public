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
