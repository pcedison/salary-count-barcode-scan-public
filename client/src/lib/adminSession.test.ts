import { describe, expect, it } from 'vitest';

import {
  isAdminSessionIdleExpired,
  resolveAdminSessionPolicy,
  shouldRefreshAdminSession
} from './adminSession';

describe('admin session client helpers', () => {
  it('resolves session policy from server responses and falls back safely', () => {
    expect(
      resolveAdminSessionPolicy({
        sessionTimeoutMinutes: 15
      })
    ).toMatchObject({
      timeoutMinutes: 15,
      timeoutMs: 15 * 60 * 1000,
      refreshIntervalMs: 225 * 1000
    });

    expect(
      resolveAdminSessionPolicy({
        sessionTimeoutMs: 90 * 1000
      })
    ).toMatchObject({
      timeoutMinutes: 2,
      timeoutMs: 90 * 1000,
      refreshIntervalMs: 60 * 1000
    });

    expect(resolveAdminSessionPolicy(null)).toMatchObject({
      timeoutMinutes: 60,
      timeoutMs: 60 * 60 * 1000
    });
  });

  it('uses the shared timeout policy for idle expiry and heartbeat throttling', () => {
    expect(
      isAdminSessionIdleExpired({
        now: 10 * 60 * 1000,
        lastActivityAt: 0,
        timeoutMs: 10 * 60 * 1000
      })
    ).toBe(true);

    expect(
      shouldRefreshAdminSession({
        now: 4 * 60 * 1000,
        lastActivityAt: 3 * 60 * 1000,
        lastRefreshAt: 0,
        timeoutMs: 10 * 60 * 1000,
        refreshIntervalMs: 2 * 60 * 1000
      })
    ).toBe(true);

    expect(
      shouldRefreshAdminSession({
        now: 90 * 1000,
        lastActivityAt: 30 * 1000,
        lastRefreshAt: 45 * 1000,
        timeoutMs: 10 * 60 * 1000,
        refreshIntervalMs: 60 * 1000
      })
    ).toBe(false);

    expect(
      shouldRefreshAdminSession({
        now: 12 * 60 * 1000,
        lastActivityAt: 0,
        lastRefreshAt: 0,
        timeoutMs: 10 * 60 * 1000,
        refreshIntervalMs: 2 * 60 * 1000
      })
    ).toBe(false);
  });
});
