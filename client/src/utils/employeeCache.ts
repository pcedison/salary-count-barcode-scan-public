import type { Employee } from '../types/employee';

type EmployeeCacheEntry = Pick<Employee, 'id' | 'name' | 'department' | 'idNumber'>;

const isDev = import.meta.env.DEV;

function debugLog(...args: unknown[]) {
  if (isDev) {
    console.log(...args);
  }
}

function toCacheEntry(employee: Pick<Employee, 'id'> & Partial<Employee>): EmployeeCacheEntry {
  return {
    id: employee.id,
    name: employee.name || '未知姓名',
    department: employee.department || '未指定部門',
    idNumber: employee.idNumber || ''
  };
}

export const employeeCache = new Map<number, EmployeeCacheEntry>();

export function initEmployeeCache(employees: Employee[]) {
  employees.forEach((employee) => {
    employeeCache.set(employee.id, toCacheEntry(employee));
  });

  debugLog(`員工緩存已初始化，共 ${employeeCache.size} 名員工`);
}

export function getEmployeeFromCache(id: number) {
  return employeeCache.get(id);
}

export function updateEmployeeCache(employee: Pick<Employee, 'id'> & Partial<Employee>) {
  employeeCache.set(employee.id, toCacheEntry(employee));
  debugLog(`員工緩存已更新: ${employee.name || employee.id}`);
}

export function clearEmployeeCache() {
  employeeCache.clear();
  debugLog('員工緩存已清除');
}
