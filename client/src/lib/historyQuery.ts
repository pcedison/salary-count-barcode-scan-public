export interface SalaryHistoryFilters {
  page: number;
  limit: number;
  year?: string;
  employeeId?: string;
  search?: string;
}
export function buildSalaryHistoryQuery(filters: SalaryHistoryFilters): string {
  const params = new URLSearchParams({ page: String(filters.page), limit: String(filters.limit) });
  if (filters.year) params.set('year', filters.year);
  if (filters.employeeId) params.set('employeeId', filters.employeeId);
  if (filters.search?.trim()) params.set('search', filters.search.trim());
  return `/api/salary-records?${params}`;
}
