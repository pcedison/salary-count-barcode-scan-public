import { beforeEach, describe, expect, it, vi } from 'vitest';
import { drizzle } from 'drizzle-orm/postgres-js';

import { monthlySalaryRuns } from '@shared/schema';

const dbMock = vi.hoisted(() => ({
  insert: vi.fn(),
  values: vi.fn(),
  onConflictDoUpdate: vi.fn(),
  returning: vi.fn(),
}));

vi.mock('../db', () => ({ db: dbMock }));

import { DatabaseMonthlySalaryRunRepository } from './monthlySalaryRunRepository';

function compileConflictOptions(options: unknown) {
  const mockDatabase = drizzle.mock();
  const insert = mockDatabase.insert(monthlySalaryRuns).values({
    runKey: '2026-07',
    salaryYear: 2026,
    salaryMonth: 7,
    status: 'running',
  });
  type ConflictOptions = Parameters<typeof insert.onConflictDoUpdate>[0];

  return insert.onConflictDoUpdate(options as ConflictOptions).toSQL();
}

describe('DatabaseMonthlySalaryRunRepository.acquireRun', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMock.insert.mockReturnValue({ values: dbMock.values });
    dbMock.values.mockReturnValue({ onConflictDoUpdate: dbMock.onConflictDoUpdate });
    dbMock.onConflictDoUpdate.mockReturnValue({ returning: dbMock.returning });
    dbMock.returning.mockResolvedValue([
      {
        id: 1,
        runKey: '2026-07',
        salaryYear: 2026,
        salaryMonth: 7,
        status: 'running',
      },
    ]);
  });

  it('keeps an atomic status guard when force is enabled', async () => {
    const repository = new DatabaseMonthlySalaryRunRepository();

    await repository.acquireRun({
      year: 2026,
      month: 7,
      runKey: '2026-07',
      force: true,
      emailRecipients: ['payroll@example.com'],
    });

    expect(dbMock.onConflictDoUpdate).toHaveBeenCalledOnce();
    const conflictOptions = dbMock.onConflictDoUpdate.mock.calls[0][0] as {
      setWhere?: unknown;
    };
    expect(conflictOptions.setWhere).toBeDefined();

    const compiled = compileConflictOptions(conflictOptions);
    expect(compiled.sql).toMatch(/where "monthly_salary_runs"\."status" <> \$\d+$/);
    expect(compiled.params.at(-1)).toBe('running');
  });
});
