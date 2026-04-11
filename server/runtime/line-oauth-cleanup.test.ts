import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { startLineOAuthCleanup } from './line-oauth-cleanup';

describe('startLineOAuthCleanup', () => {
  const originalLineChannelId = process.env.LINE_LOGIN_CHANNEL_ID;

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    process.env.LINE_LOGIN_CHANNEL_ID = originalLineChannelId;
    vi.useRealTimers();
  });

  it('does nothing when LINE login is not configured', async () => {
    delete process.env.LINE_LOGIN_CHANNEL_ID;

    const importStorage = vi.fn();
    const cleanup = startLineOAuthCleanup({ importStorage });

    await Promise.resolve();

    expect(importStorage).not.toHaveBeenCalled();

    cleanup.stop();
  });

  it('starts and stops the cleanup interval when LINE login is configured', async () => {
    process.env.LINE_LOGIN_CHANNEL_ID = 'line-channel';

    const cleanupExpiredOAuthStates = vi.fn().mockResolvedValue(undefined);
    const importStorage = vi.fn().mockResolvedValue({
      storage: { cleanupExpiredOAuthStates },
    });
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');

    const cleanup = startLineOAuthCleanup({ importStorage, intervalMs: 10_000 });

    await Promise.resolve();
    await Promise.resolve();

    expect(importStorage).toHaveBeenCalledTimes(1);
    expect(setIntervalSpy).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(cleanupExpiredOAuthStates).toHaveBeenCalledTimes(1);

    cleanup.stop();
    expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
  });

  it('does not schedule the interval if stopped before storage resolves', async () => {
    process.env.LINE_LOGIN_CHANNEL_ID = 'line-channel';

    let resolveStorage: ((value: { storage: { cleanupExpiredOAuthStates: () => Promise<void> } }) => void) | null =
      null;
    const importStorage = vi.fn(
      () =>
        new Promise<{ storage: { cleanupExpiredOAuthStates: () => Promise<void> } }>((resolve) => {
          resolveStorage = resolve;
        })
    );
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');

    const cleanup = startLineOAuthCleanup({ importStorage });
    cleanup.stop();

    resolveStorage?.({
      storage: {
        cleanupExpiredOAuthStates: vi.fn().mockResolvedValue(undefined),
      },
    });

    await Promise.resolve();
    await Promise.resolve();

    expect(setIntervalSpy).not.toHaveBeenCalled();
  });
});
