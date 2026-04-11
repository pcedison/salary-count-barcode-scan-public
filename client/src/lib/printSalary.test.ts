import { describe, expect, it } from 'vitest';

import { parseSalaryRecordId } from './printSalary';

describe('print salary helpers', () => {
  it('accepts positive integer record ids from query strings', () => {
    expect(parseSalaryRecordId('?id=7')).toBe(7);
    expect(parseSalaryRecordId('?foo=bar&id=42')).toBe(42);
    expect(parseSalaryRecordId('?id=007')).toBe(7);
  });

  it('rejects missing, malformed, and non-positive record ids', () => {
    expect(parseSalaryRecordId('')).toBeNull();
    expect(parseSalaryRecordId('?id=')).toBeNull();
    expect(parseSalaryRecordId('?id=abc')).toBeNull();
    expect(parseSalaryRecordId('?id=7abc')).toBeNull();
    expect(parseSalaryRecordId('?id=-1')).toBeNull();
    expect(parseSalaryRecordId('?id=0')).toBeNull();
  });
});
