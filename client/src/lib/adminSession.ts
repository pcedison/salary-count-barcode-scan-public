import {
  DEFAULT_ADMIN_SESSION_POLICY,
  createAdminSessionPolicy,
  createAdminSessionPolicyFromMs,
  type AdminSessionPolicy
} from '@shared/utils/adminSessionPolicy';

interface AdminSessionTimingState {
  now: number;
  lastActivityAt: number;
  timeoutMs: number;
}

interface AdminSessionRefreshState extends AdminSessionTimingState {
  lastRefreshAt: number;
  refreshIntervalMs: number;
}

function toPositiveNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return value;
  }

  if (typeof value === 'string' && /^\d+$/.test(value)) {
    const parsedValue = Number.parseInt(value, 10);
    return parsedValue > 0 ? parsedValue : null;
  }

  return null;
}

export function resolveAdminSessionPolicy(payload: unknown): AdminSessionPolicy {
  if (!payload || typeof payload !== 'object') {
    return DEFAULT_ADMIN_SESSION_POLICY;
  }

  const response = payload as Record<string, unknown>;
  const timeoutMinutes = toPositiveNumber(response.sessionTimeoutMinutes);

  if (timeoutMinutes !== null) {
    return createAdminSessionPolicy(timeoutMinutes);
  }

  const timeoutMs = toPositiveNumber(response.sessionTimeoutMs);
  if (timeoutMs !== null) {
    return createAdminSessionPolicyFromMs(timeoutMs);
  }

  return DEFAULT_ADMIN_SESSION_POLICY;
}

export function isAdminSessionIdleExpired({
  now,
  lastActivityAt,
  timeoutMs
}: AdminSessionTimingState): boolean {
  return now - lastActivityAt >= timeoutMs;
}

export function shouldRefreshAdminSession({
  now,
  lastActivityAt,
  lastRefreshAt,
  timeoutMs,
  refreshIntervalMs
}: AdminSessionRefreshState): boolean {
  if (isAdminSessionIdleExpired({ now, lastActivityAt, timeoutMs })) {
    return false;
  }

  return now - lastRefreshAt >= refreshIntervalMs;
}
