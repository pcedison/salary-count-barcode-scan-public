import crypto from 'crypto';

const DEFAULT_TOKEN_TTL_MS = 5 * 60 * 1000;
const DEVELOPMENT_PRINT_TOKEN_SECRET = 'development-salary-print-token-secret-do-not-use';

function getSalaryPrintTokenSecret(): string {
  const configuredSecret =
    process.env.SALARY_PRINT_TOKEN_SECRET ||
    process.env.SESSION_SECRET;

  if (configuredSecret && configuredSecret.length >= 32) {
    return configuredSecret;
  }

  if (process.env.NODE_ENV === 'production') {
    throw new Error('SESSION_SECRET or SALARY_PRINT_TOKEN_SECRET is required for salary print tokens.');
  }

  return DEVELOPMENT_PRINT_TOKEN_SECRET;
}

export function normalizeSalaryPrintRecordIds(recordIds: Array<number | string>): number[] {
  const normalizedIds = recordIds
    .map((id) => Number.parseInt(String(id), 10))
    .filter((id) => Number.isInteger(id) && id > 0);

  return Array.from(new Set(normalizedIds));
}

function buildTokenPayload(recordIds: number[], expiresAtMs: number): string {
  return `${recordIds.join(',')}.${expiresAtMs}`;
}

function signPayload(payload: string): string {
  return crypto
    .createHmac('sha256', getSalaryPrintTokenSecret())
    .update(payload)
    .digest('base64url');
}

function secureEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);

  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

export function createSalaryPrintToken(
  recordIds: Array<number | string>,
  options: { now?: Date; ttlMs?: number } = {}
): string {
  const ids = normalizeSalaryPrintRecordIds(recordIds);
  if (ids.length === 0) {
    throw new Error('Cannot create a salary print token without record IDs.');
  }

  const now = options.now ?? new Date();
  const ttlMs = options.ttlMs ?? DEFAULT_TOKEN_TTL_MS;
  const expiresAtMs = now.getTime() + ttlMs;
  const payload = buildTokenPayload(ids, expiresAtMs);

  return `${expiresAtMs}.${signPayload(payload)}`;
}

export function verifySalaryPrintToken(
  recordIds: Array<number | string>,
  token: unknown,
  now = new Date()
): boolean {
  if (typeof token !== 'string' || token.length === 0) {
    return false;
  }

  const ids = normalizeSalaryPrintRecordIds(recordIds);
  if (ids.length === 0) {
    return false;
  }

  const [rawExpiresAt, signature, ...extraParts] = token.split('.');
  if (!rawExpiresAt || !signature || extraParts.length > 0 || !/^\d+$/.test(rawExpiresAt)) {
    return false;
  }

  const expiresAtMs = Number.parseInt(rawExpiresAt, 10);
  if (!Number.isFinite(expiresAtMs) || expiresAtMs < now.getTime()) {
    return false;
  }

  const expectedSignature = signPayload(buildTokenPayload(ids, expiresAtMs));
  return secureEqual(signature, expectedSignature);
}
