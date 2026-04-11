export const DEFAULT_ADMIN_SESSION_TIMEOUT_MINUTES = 60;

const MIN_ADMIN_SESSION_TIMEOUT_MINUTES = 1;
const MIN_ADMIN_SESSION_TIMEOUT_MS = MIN_ADMIN_SESSION_TIMEOUT_MINUTES * 60 * 1000;
const MIN_ADMIN_SESSION_REFRESH_INTERVAL_MS = 60 * 1000;
const MAX_ADMIN_SESSION_REFRESH_INTERVAL_MS = 5 * 60 * 1000;

export interface AdminSessionPolicy {
  timeoutMinutes: number;
  timeoutMs: number;
  refreshIntervalMs: number;
}

export function parseAdminSessionTimeoutMinutes(rawValue?: string | null): number {
  const parsedValue = Number.parseInt(rawValue ?? '', 10);

  if (!Number.isFinite(parsedValue) || parsedValue < MIN_ADMIN_SESSION_TIMEOUT_MINUTES) {
    return DEFAULT_ADMIN_SESSION_TIMEOUT_MINUTES;
  }

  return parsedValue;
}

export function getAdminSessionRefreshIntervalMs(timeoutMs: number): number {
  const quarterWindowMs = Math.floor(timeoutMs / 4);

  return Math.max(
    MIN_ADMIN_SESSION_REFRESH_INTERVAL_MS,
    Math.min(MAX_ADMIN_SESSION_REFRESH_INTERVAL_MS, quarterWindowMs)
  );
}

export function createAdminSessionPolicyFromMs(timeoutMs: number): AdminSessionPolicy {
  const safeTimeoutMs =
    Number.isFinite(timeoutMs) && timeoutMs >= MIN_ADMIN_SESSION_TIMEOUT_MS
      ? Math.floor(timeoutMs)
      : DEFAULT_ADMIN_SESSION_TIMEOUT_MINUTES * 60 * 1000;

  return {
    timeoutMinutes: Math.ceil(safeTimeoutMs / (60 * 1000)),
    timeoutMs: safeTimeoutMs,
    refreshIntervalMs: getAdminSessionRefreshIntervalMs(safeTimeoutMs)
  };
}

export function createAdminSessionPolicy(timeoutMinutes: number): AdminSessionPolicy {
  return createAdminSessionPolicyFromMs(timeoutMinutes * 60 * 1000);
}

export const DEFAULT_ADMIN_SESSION_POLICY = createAdminSessionPolicy(
  DEFAULT_ADMIN_SESSION_TIMEOUT_MINUTES
);
