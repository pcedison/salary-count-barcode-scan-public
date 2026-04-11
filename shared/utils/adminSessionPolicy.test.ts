import { describe, expect, it } from 'vitest';

import {
  DEFAULT_ADMIN_SESSION_TIMEOUT_MINUTES,
  createAdminSessionPolicy,
  createAdminSessionPolicyFromMs,
  parseAdminSessionTimeoutMinutes
} from './adminSessionPolicy';

describe('admin session policy helpers', () => {
  it('falls back to the default timeout when env input is missing or invalid', () => {
    expect(parseAdminSessionTimeoutMinutes(undefined)).toBe(DEFAULT_ADMIN_SESSION_TIMEOUT_MINUTES);
    expect(parseAdminSessionTimeoutMinutes('')).toBe(DEFAULT_ADMIN_SESSION_TIMEOUT_MINUTES);
    expect(parseAdminSessionTimeoutMinutes('0')).toBe(DEFAULT_ADMIN_SESSION_TIMEOUT_MINUTES);
    expect(parseAdminSessionTimeoutMinutes('abc')).toBe(DEFAULT_ADMIN_SESSION_TIMEOUT_MINUTES);
  });

  it('creates a refresh interval bounded between one and five minutes', () => {
    expect(createAdminSessionPolicy(60)).toMatchObject({
      timeoutMinutes: 60,
      timeoutMs: 60 * 60 * 1000,
      refreshIntervalMs: 5 * 60 * 1000
    });

    expect(createAdminSessionPolicy(5)).toMatchObject({
      timeoutMinutes: 5,
      timeoutMs: 5 * 60 * 1000,
      refreshIntervalMs: 75 * 1000
    });

    expect(createAdminSessionPolicyFromMs(30 * 1000)).toMatchObject({
      timeoutMinutes: DEFAULT_ADMIN_SESSION_TIMEOUT_MINUTES,
      timeoutMs: DEFAULT_ADMIN_SESSION_TIMEOUT_MINUTES * 60 * 1000,
      refreshIntervalMs: 5 * 60 * 1000
    });
  });
});
