import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const startMonitoring = vi.fn(() => ({ kind: 'monitor' } as unknown as NodeJS.Timeout));
const setupAutomaticBackups = vi.fn(() => ({ kind: 'backup' } as unknown as NodeJS.Timeout));
const stopMonitoring = vi.fn();
const stopAutomaticBackups = vi.fn();

const startEmployeeRetentionScheduler = vi.fn(() => ({ kind: 'retention' } as unknown as NodeJS.Timeout));
const stopEmployeeRetentionScheduler = vi.fn();

const loadCalculationRulesFromDb = vi.fn();
const ensureRuntimeDirectoriesExist = vi.fn(async () => {});
const lineCleanupStop = vi.fn();
const startLineOAuthCleanup = vi.fn(() => ({ stop: lineCleanupStop }));
const monthlySalaryStop = vi.fn();
const startMonthlySalaryScheduler = vi.fn(() => ({ stop: monthlySalaryStop }));

vi.mock('../db-monitoring', () => ({
  startMonitoring,
  setupAutomaticBackups,
  stopMonitoring,
  stopAutomaticBackups,
}));

vi.mock('../employee-retention', () => ({
  startEmployeeRetentionScheduler,
  stopEmployeeRetentionScheduler,
}));

vi.mock('../services/calculationRulesLoader', () => ({
  loadCalculationRulesFromDb,
}));
vi.mock('../config/runtimePaths', () => ({ ensureRuntimeDirectoriesExist }));

vi.mock('../runtime/line-oauth-cleanup', () => ({
  startLineOAuthCleanup,
}));

vi.mock('../runtime/monthly-salary-scheduler', () => ({
  startMonthlySalaryScheduler,
}));

describe('startRuntimeServices', () => {
  afterEach(() => vi.unstubAllEnvs());
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('disabled role loads business rules once but starts no monitoring, backup, retention, OAuth or salary work', async () => {
    vi.stubEnv('APP_BACKGROUND_SERVICES', 'disabled');
    const { startRuntimeServices } = await import('./runtime-services');
    const services = startRuntimeServices(); services.stop(); services.stop();
    expect(loadCalculationRulesFromDb).toHaveBeenCalledOnce();
    expect(ensureRuntimeDirectoriesExist).toHaveBeenCalledOnce();
    for (const job of [startMonitoring, setupAutomaticBackups, startEmployeeRetentionScheduler, startLineOAuthCleanup, startMonthlySalaryScheduler]) expect(job).not.toHaveBeenCalled();
  });

  it('starts all runtime jobs and stops them through a single contract', async () => {
    const { startRuntimeServices } = await import('./runtime-services');

    const runtimeServices = startRuntimeServices({ monitoringIntervalMs: 15_000 });

    expect(loadCalculationRulesFromDb).toHaveBeenCalledTimes(1);
    expect(startMonitoring).toHaveBeenCalledWith(15_000);
    expect(setupAutomaticBackups).toHaveBeenCalledTimes(1);
    expect(startEmployeeRetentionScheduler).toHaveBeenCalledTimes(1);
    expect(startLineOAuthCleanup).toHaveBeenCalledTimes(1);
    expect(startMonthlySalaryScheduler).toHaveBeenCalledTimes(1);

    runtimeServices.stop();

    expect(stopMonitoring).toHaveBeenCalledWith(expect.objectContaining({ kind: 'monitor' }));
    expect(stopAutomaticBackups).toHaveBeenCalledWith(expect.objectContaining({ kind: 'backup' }));
    expect(stopEmployeeRetentionScheduler).toHaveBeenCalledWith(expect.objectContaining({ kind: 'retention' }));
    expect(lineCleanupStop).toHaveBeenCalledTimes(1);
    expect(monthlySalaryStop).toHaveBeenCalledTimes(1);
  });

  it('makes stop idempotent', async () => {
    const { startRuntimeServices } = await import('./runtime-services');

    const runtimeServices = startRuntimeServices();

    runtimeServices.stop();
    runtimeServices.stop();

    expect(stopMonitoring).toHaveBeenCalledTimes(1);
    expect(stopAutomaticBackups).toHaveBeenCalledTimes(1);
    expect(stopEmployeeRetentionScheduler).toHaveBeenCalledTimes(1);
    expect(lineCleanupStop).toHaveBeenCalledTimes(1);
    expect(monthlySalaryStop).toHaveBeenCalledTimes(1);
  });
});
