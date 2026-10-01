export function salaryImportTarget(type: 'employee' | 'record', value: string): { employeeId: number } | { recordId: number } | null {
  if (!/^[1-9]\d*$/.test(value)) return null;
  const id = Number(value);
  if (!Number.isSafeInteger(id)) return null;
  return type === 'record' ? { recordId: id } : { employeeId: id };
}
