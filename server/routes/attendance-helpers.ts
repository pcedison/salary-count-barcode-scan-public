import { normalizeDateToDash } from '@shared/utils/specialLeaveSync';

export function getTodayDateKey(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');

  return `${year}-${month}-${day}`;
}

export function filterAttendanceRecordsByDate<T extends { date: string }>(
  records: T[],
  targetDateKey: string
): T[] {
  return records.filter(record => normalizeDateToDash(record.date) === targetDateKey);
}
