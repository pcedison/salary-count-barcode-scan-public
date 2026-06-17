import { describe, expect, it } from 'vitest';

import { parseSalaryRecordId, parseSalaryRecordIds } from './printSalary';

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

  it('parses batch salary record ids for monthly printing', () => {
    expect(parseSalaryRecordIds('?ids=11,12,12,003')).toEqual([11, 12, 3]);
    expect(parseSalaryRecordIds('?token=x&ids=4%2C5')).toEqual([4, 5]);
  });

  it('rejects malformed batch salary record ids', () => {
    expect(parseSalaryRecordIds('')).toEqual([]);
    expect(parseSalaryRecordIds('?ids=')).toEqual([]);
    expect(parseSalaryRecordIds('?ids=1,abc')).toEqual([]);
    expect(parseSalaryRecordIds('?ids=-1,2')).toEqual([]);
  });
});
