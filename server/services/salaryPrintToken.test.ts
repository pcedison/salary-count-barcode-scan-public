import { describe, expect, it } from 'vitest';

import {
  createSalaryPrintToken,
  normalizeSalaryPrintRecordIds,
  verifySalaryPrintToken,
} from './salaryPrintToken';

describe('salary print tokens', () => {
  it('normalizes salary record IDs before signing', () => {
    expect(normalizeSalaryPrintRecordIds(['3', 3, 'bad', 0, '9'])).toEqual([3, 9]);
  });

  it('accepts a fresh token for the signed record IDs', () => {
    const now = new Date('2026-05-01T00:00:00.000Z');
    const token = createSalaryPrintToken([9, 10], { now, ttlMs: 60_000 });

    expect(verifySalaryPrintToken([9, 10], token, new Date('2026-05-01T00:00:30.000Z'))).toBe(true);
    expect(verifySalaryPrintToken([9], token, new Date('2026-05-01T00:00:30.000Z'))).toBe(false);
  });

  it('rejects expired tokens', () => {
    const now = new Date('2026-05-01T00:00:00.000Z');
    const token = createSalaryPrintToken([9], { now, ttlMs: 1000 });

    expect(verifySalaryPrintToken([9], token, new Date('2026-05-01T00:00:02.000Z'))).toBe(false);
  });
});
