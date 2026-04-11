import { setupAutomaticBackups, startMonitoring, stopAutomaticBackups, stopMonitoring } from '../db-monitoring';
import { ensureRuntimeDirectoriesExist } from '../config/runtimePaths';
import { startEmployeeRetentionScheduler, stopEmployeeRetentionScheduler } from '../employee-retention';
import { loadCalculationRulesFromDb } from '../services/calculationRulesLoader';
import { createLogger } from '../utils/logger';
import { startLineOAuthCleanup, type RuntimeStoppable } from '../runtime/line-oauth-cleanup';

type RuntimeLogger = {
  info(message: string, ...meta: unknown[]): void;
  warn(message: string, ...meta: unknown[]): void;
  error(message: string, ...meta: unknown[]): void;
};

type StartRuntimeServicesOptions = {
  monitoringIntervalMs?: number;
  logger?: RuntimeLogger;
};

const DEFAULT_MONITORING_INTERVAL_MS = 60_000;
const log = createLogger('runtime-services');

export function startRuntimeServices(
  options: StartRuntimeServicesOptions = {}
): RuntimeStoppable {
  const {
    monitoringIntervalMs = DEFAULT_MONITORING_INTERVAL_MS,
    logger = log,
  } = options;

  void ensureRuntimeDirectoriesExist().catch((error) => {
    logger.error('Failed to prepare runtime directories', error);
  });

  void loadCalculationRulesFromDb();

  const monitoringHandle = startMonitoring(monitoringIntervalMs);
  const backupHandle = setupAutomaticBackups();
  const retentionHandle = startEmployeeRetentionScheduler();
  const lineOAuthCleanup = startLineOAuthCleanup({ logger });

  let stopped = false;

  return {
    stop() {
      if (stopped) {
        return;
      }

      stopped = true;
      stopMonitoring(monitoringHandle);
      stopAutomaticBackups(backupHandle);
      stopEmployeeRetentionScheduler(retentionHandle);
      lineOAuthCleanup.stop();
    },
  };
}
