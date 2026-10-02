import { beforeEach, describe, expect, it, vi } from 'vitest';
import { drizzle } from 'drizzle-orm/postgres-js';

import { monthlySalaryRuns } from '@shared/schema';

const dbMock = vi.hoisted(() => ({
  insert: vi.fn(),
  values: vi.fn(),
  onConflictDoUpdate: vi.fn(),
  returning: vi.fn(),
  select: vi.fn(), from: vi.fn(), where: vi.fn(),
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
    dbMock.select.mockReturnValue({ from: dbMock.from });
    dbMock.from.mockReturnValue({ where: dbMock.where });
    dbMock.where.mockResolvedValue([{ id: 1, runKey: '2026-07', salaryYear: 2026, salaryMonth: 7, status: 'running' }]);
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

  it('treats a concurrent run-key conflict as skipped only after matching the existing month and key', async () => {
    const error = new Error('Synthetic query conflict', { cause: { code: '23505', constraint_name: 'monthly_salary_runs_run_key_unique' } });
    dbMock.returning.mockRejectedValueOnce(error);
    const result = await new DatabaseMonthlySalaryRunRepository().acquireRun({
      year: 2026, month: 7, runKey: '2026-07', force: true, emailRecipients: [],
    });
    expect(result).toMatchObject({ run: { runKey: '2026-07', salaryYear: 2026, salaryMonth: 7 }, skipReason: 'monthly salary run is already running' });
    expect(dbMock.insert).toHaveBeenCalledOnce();
  });

  it.each([
    [],
    [{ runKey: 'another-key', salaryYear: 2026, salaryMonth: 7, status: 'running' }],
    [{ runKey: '2026-07', salaryYear: 2026, salaryMonth: 8, status: 'running' }],
  ].map(rows => ({ rows })))('does not hide a run-key conflict without an identical existing run: %j', async ({ rows }) => {
    const error = new Error('Synthetic query conflict', { cause: { code: '23505', constraint_name: 'monthly_salary_runs_run_key_unique' } });
    dbMock.returning.mockRejectedValueOnce(error);
    dbMock.where.mockResolvedValueOnce(rows);
    await expect(new DatabaseMonthlySalaryRunRepository().acquireRun({
      year: 2026, month: 7, runKey: '2026-07', force: true, emailRecipients: [],
    })).rejects.toBe(error);
  });

  it.each([
    { code: '23505', constraint_name: 'unrelated_unique' },
    { code: '08006', constraint_name: 'monthly_salary_runs_run_key_unique' },
  ])('propagates unrelated database failures: %j', async (cause) => {
    const error = new Error('Synthetic unrelated database failure', { cause });
    dbMock.returning.mockRejectedValueOnce(error);
    await expect(new DatabaseMonthlySalaryRunRepository().acquireRun({
      year: 2026, month: 7, runKey: '2026-07', force: true, emailRecipients: [],
    })).rejects.toBe(error);
    expect(dbMock.select).not.toHaveBeenCalled();
  });
});
