import crypto from 'node:crypto';
import type { SalaryRecord } from '@shared/schema';

const localSecret = crypto.randomBytes(32).toString('hex');
function secret() {
  const value = process.env.SESSION_SECRET;
  if (value && value.length >= 32) return value;
  if (process.env.NODE_ENV === 'production') throw new Error('SESSION_SECRET is required for payroll previews.');
  return localSecret;
}
function canonical(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, val]) => [key, canonical(val)]));
  }
  return value;
}
export function payrollHash(value: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}
export function payrollActorId(sessionId: string): string {
  return crypto.createHmac('sha256', secret()).update(`payroll-actor:${sessionId}`).digest('hex');
}
function signature(payload: string): string {
  return crypto.createHmac('sha256', secret()).update(`payroll-preview:${payload}`).digest('base64url');
}
export function createPayrollPreviewToken(record: SalaryRecord, request: unknown, actorId: string, now = Date.now()): string {
  const payload = Buffer.from(JSON.stringify({ exp: now + 10 * 60_000, recordId: record.id, revision: record.revision ?? 0, beforeHash: payrollHash(record), requestHash: payrollHash(request), actorId })).toString('base64url');
  return `${payload}.${signature(payload)}`;
}
export function verifyPayrollPreviewToken(token: string, record: SalaryRecord, request: unknown, actorId: string, now = Date.now()): boolean {
  if (token.length > 2048) return false;
  const [payload, signed, ...extra] = token.split('.');
  if (!payload || !signed || extra.length) return false;
  const expected = Buffer.from(signature(payload));
  const actual = Buffer.from(signed);
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return false;
  try {
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return Number.isSafeInteger(decoded.exp) && decoded.exp > now && decoded.exp <= now + 10 * 60_000 && decoded.recordId === record.id && decoded.revision === (record.revision ?? 0) && decoded.beforeHash === payrollHash(record) && decoded.requestHash === payrollHash(request) && decoded.actorId === actorId;
  } catch { return false; }
}
