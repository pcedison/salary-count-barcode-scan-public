import { describe, expect, it } from 'vitest';
import { salaryImportTarget } from './csvImportTarget';
describe('explicit salary CSV import target', () => {
  it('sends an exact employee target instead of guessing from the CSV month', () => expect(salaryImportTarget('employee', '7')).toEqual({ employeeId: 7 }));
  it('sends an exact historical record target', () => expect(salaryImportTarget('record', '101')).toEqual({ recordId: 101 }));
  it.each(['', '0', '-1', '1.5', '1e3', 'NaN', '9007199254740992'])('rejects an absent or invalid target %s', (value) => expect(salaryImportTarget('record', value)).toBeNull());
});
