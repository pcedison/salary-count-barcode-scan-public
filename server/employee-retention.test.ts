import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

let runEmployeeRetentionCycle: typeof import('./employee-retention').runEmployeeRetentionCycle;
let startEmployeeRetentionScheduler: typeof import('./employee-retention').startEmployeeRetentionScheduler;
let stopEmployeeRetentionScheduler: typeof import('./employee-retention').stopEmployeeRetentionScheduler;

beforeEach(async () => {
  vi.clearAllMocks();
  vi.useRealTimers();

  ({
    runEmployeeRetentionCycle,
    startEmployeeRetentionScheduler,
    stopEmployeeRetentionScheduler
  } = await import('./employee-retention'));
});

afterEach(() => {
  stopEmployeeRetentionScheduler();
});

describe('employee retention scheduler', () => {
  it('runs employee and salary retention cleanup in a single cycle', async () => {
    const result = await runEmployeeRetentionCycle();

    expect(storageMock.purgeExpiredDeletedEmployees).toHaveBeenCalledTimes(1);
    expect(storageMock.purgeExpiredRetainedSalaryRecords).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      purgedEmployeeIds: [5],
      anonymizedSalaryRecords: 2,
      purgedSalaryRecords: 1
    });
  });

  it('avoids duplicate scheduler registration and can stop cleanly', () => {
    vi.useFakeTimers();

    const firstHandle = startEmployeeRetentionScheduler(60_000);
    const secondHandle = startEmployeeRetentionScheduler(60_000);

    expect(firstHandle).toBeTruthy();
    expect(secondHandle).toBe(firstHandle);

    stopEmployeeRetentionScheduler(firstHandle);
    const restartedHandle = startEmployeeRetentionScheduler(60_000);

    expect(restartedHandle).toBeTruthy();
    expect(restartedHandle).not.toBe(firstHandle);
  });

  it('runs the scheduled cleanup branch on interval and stops future executions', async () => {
    vi.useFakeTimers();

    const handle = startEmployeeRetentionScheduler(60_000);

    await Promise.resolve();
    await Promise.resolve();

    expect(storageMock.purgeExpiredDeletedEmployees).toHaveBeenCalledTimes(1);
    expect(storageMock.purgeExpiredRetainedSalaryRecords).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(60_000);
    await Promise.resolve();
    await Promise.resolve();

    expect(storageMock.purgeExpiredDeletedEmployees).toHaveBeenCalledTimes(2);
    expect(storageMock.purgeExpiredRetainedSalaryRecords).toHaveBeenCalledTimes(2);

    stopEmployeeRetentionScheduler(handle);

    await vi.advanceTimersByTimeAsync(60_000);
    await Promise.resolve();
    await Promise.resolve();

    expect(storageMock.purgeExpiredDeletedEmployees).toHaveBeenCalledTimes(2);
    expect(storageMock.purgeExpiredRetainedSalaryRecords).toHaveBeenCalledTimes(2);
  });
});
