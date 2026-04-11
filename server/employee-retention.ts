import { createLogger } from './utils/logger';
import { storage } from './storage';

const log = createLogger('employee-retention');
const DEFAULT_RETENTION_INTERVAL_MS = 12 * 60 * 60 * 1000;

let retentionHandle: NodeJS.Timeout | null = null;

export async function runEmployeeRetentionCycle(): Promise<{
  purgedEmployeeIds: number[];
  anonymizedSalaryRecords: number;
  purgedSalaryRecords: number;
}> {
  const { purgedEmployeeIds, anonymizedSalaryRecords } = await storage.purgeExpiredDeletedEmployees();
  const purgedSalaryRecords = await storage.purgeExpiredRetainedSalaryRecords();

  if (purgedEmployeeIds.length > 0 || anonymizedSalaryRecords > 0 || purgedSalaryRecords > 0) {
    log.info('Employee retention cycle completed', {
      purgedEmployeeIds,
      anonymizedSalaryRecords,
      purgedSalaryRecords
    });
  }

  return {
    purgedEmployeeIds,
    anonymizedSalaryRecords,
    purgedSalaryRecords
  };
}

export function startEmployeeRetentionScheduler(
  intervalMs = DEFAULT_RETENTION_INTERVAL_MS
): NodeJS.Timeout | null {
  if (retentionHandle) {
    log.warn('Employee retention scheduler already running; skipping duplicate start');
    return retentionHandle;
  }

  void runEmployeeRetentionCycle().catch((error) => {
    log.error('Initial employee retention cycle failed', error);
  });

  retentionHandle = setInterval(() => {
    void runEmployeeRetentionCycle().catch((error) => {
      log.error('Scheduled employee retention cycle failed', error);
    });
  }, intervalMs);

  return retentionHandle;
}

export function stopEmployeeRetentionScheduler(handle?: NodeJS.Timeout | null): void {
  const resolvedHandle = handle ?? retentionHandle;
  if (!resolvedHandle) {
    return;
  }

  clearInterval(resolvedHandle);
  if (resolvedHandle === retentionHandle) {
    retentionHandle = null;
  }
}
