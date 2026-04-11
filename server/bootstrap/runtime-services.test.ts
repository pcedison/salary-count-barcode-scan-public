import { beforeEach, describe, expect, it, vi } from 'vitest';

const startMonitoring = vi.fn(() => ({ kind: 'monitor' } as unknown as NodeJS.Timeout));
const setupAutomaticBackups = vi.fn(() => ({ kind: 'backup' } as unknown as NodeJS.Timeout));
const stopMonitoring = vi.fn();
const stopAutomaticBackups = vi.fn();

const startEmployeeRetentionScheduler = vi.fn(() => ({ kind: 'retention' } as unknown as NodeJS.Timeout));
const stopEmployeeRetentionScheduler = vi.fn();

const loadCalculationRulesFromDb = vi.fn();
const lineCleanupStop = vi.fn();
const startLineOAuthCleanup = vi.fn(() => ({ stop: lineCleanupStop }));

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

vi.mock('../runtime/line-oauth-cleanup', () => ({
  startLineOAuthCleanup,
}));

describe('startRuntimeServices', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('starts all runtime jobs and stops them through a single contract', async () => {
    const { startRuntimeServices } = await import('./runtime-services');

    const runtimeServices = startRuntimeServices({ monitoringIntervalMs: 15_000 });

    expect(loadCalculationRulesFromDb).toHaveBeenCalledTimes(1);
    expect(startMonitoring).toHaveBeenCalledWith(15_000);
    expect(setupAutomaticBackups).toHaveBeenCalledTimes(1);
    expect(startEmployeeRetentionScheduler).toHaveBeenCalledTimes(1);
    expect(startLineOAuthCleanup).toHaveBeenCalledTimes(1);

    runtimeServices.stop();

    expect(stopMonitoring).toHaveBeenCalledWith(expect.objectContaining({ kind: 'monitor' }));
    expect(stopAutomaticBackups).toHaveBeenCalledWith(expect.objectContaining({ kind: 'backup' }));
    expect(stopEmployeeRetentionScheduler).toHaveBeenCalledWith(expect.objectContaining({ kind: 'retention' }));
    expect(lineCleanupStop).toHaveBeenCalledTimes(1);
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
  });
});
