import { describe, expect, it } from 'vitest';
import { buildSalaryHistoryQuery } from './historyQuery';
describe('server-side salary history query', () => {
  it('requests the chosen page beyond the original first fifty records', () => {
    expect(buildSalaryHistoryQuery({ page: 7, limit: 10 })).toBe('/api/salary-records?page=7&limit=10');
  });
  it('sends year/employee/search filters to the server for the full history', () => {
    const url = new URL(buildSalaryHistoryQuery({ page: 1, limit: 10, year: '2018', employeeId: '7', search: '  Synthetic & Employee  ' }), 'https://local.test');
    expect(url.searchParams.get('year')).toBe('2018');
    expect(url.searchParams.get('employeeId')).toBe('7');
    expect(url.searchParams.get('search')).toBe('Synthetic & Employee');
  });
  it('omits blank filters', () => expect(buildSalaryHistoryQuery({ page: 1, limit: 10, year: '', employeeId: '', search: ' ' })).toBe('/api/salary-records?page=1&limit=10'));
});
